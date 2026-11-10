//! Rate limits per key, by the generic cell rate algorithm (GCRA) as `governor` judges it.
//!
//! A key has `max` attempts at once, then one more each `window / max`, so no key makes more than
//! `max` a window for long. A limiter can also count only what fails: it admits a key without
//! spending an attempt, and spends one already made. A limiter holds at most [`KEYS`] keys, spread
//! over shards by their hash, each behind a lock of its own and holding its share, so probes of
//! different keys rarely wait on each other and a flood of keys costs fixed memory: while a key's
//! shard is full, a new key there waits for the shard's sweep. A client's address counts as
//! [`network`] says.

use std::collections::HashMap;
use std::fmt;
use std::hash::{BuildHasher, Hash, RandomState};
use std::net::{IpAddr, Ipv6Addr};
use std::num::{NonZeroU32, NonZeroU64};
use std::sync::Mutex;
use std::time::Duration;

use governor::clock::{Clock, MonotonicClock, Reference};

use crate::sync::lock;

/// The most keys a limiter holds: each costs well under a hundred bytes, so a few megabytes.
pub const KEYS: usize = 65_536;

/// The most shards a limiter spreads its keys over: [`KEYS`] in shares of [`SHARD_KEYS`].
const SHARDS: usize = 64;

/// The fewest keys a shard holds, so a limiter holding few keeps them in one shard.
const SHARD_KEYS: usize = 1_024;

/// The bits of an IPv6 address that name its network: a /64, the least a provider hands one
/// subscriber, who would otherwise take a fresh allowance from each of its 2^64 addresses.
const NETWORK: u128 = !0 << 64;

/// The address a limit counts a client by: an IPv4 address whole, as an IPv6 client maps it too,
/// and any other IPv6 address by its /64.
#[must_use]
pub const fn network(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => IpAddr::V6(Ipv6Addr::from_bits(v6.to_bits() & NETWORK)),
        v4 @ IpAddr::V4(_) => v4,
    }
}

/// `duration` in nanoseconds, a span past `u64`'s 584 years held at its most.
fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

/// A shard's keys, each with its theoretical arrival time in nanoseconds from the limiter's start,
/// and when the shard last forgot those back at a fresh state.
struct Shard<K> {
    arrivals: HashMap<K, u64>,
    swept_at: u64,
}

impl<K> Shard<K> {
    /// Forgets the keys back at a fresh state, at most once a window: those whose arrival time is a
    /// period or more behind `now`, which judge as a key never seen.
    fn sweep(&mut self, now: u64, window: u64, period: u64) {
        if now.saturating_sub(self.swept_at) >= window {
            let fresh = now.saturating_sub(period);
            self.arrivals.retain(|_, arrival| *arrival > fresh);
            self.swept_at = now;
        }
    }
}

/// A limiter's shards, the first apart so that every hash falls to one.
struct Shards<K> {
    /// Picks a key's shard. Each shard's map hashes with a state of its own: under this one, a
    /// shard's keys would share the low bits that picked it, which its map places them by.
    hasher: RandomState,
    first: Mutex<Shard<K>>,
    rest: Box<[Mutex<Shard<K>>]>,
    /// The most keys a shard holds.
    each: usize,
}

impl<K: Hash> Shards<K> {
    /// Shards holding `keys` between them: as many as give each [`SHARD_KEYS`], from one to
    /// [`SHARDS`].
    fn holding(keys: usize) -> Self {
        let count = keys.checked_div(SHARD_KEYS).unwrap_or(0).clamp(1, SHARDS);
        let shard = || {
            Mutex::new(Shard {
                arrivals: HashMap::new(),
                swept_at: 0,
            })
        };
        Self {
            hasher: RandomState::new(),
            first: shard(),
            rest: std::iter::repeat_with(shard)
                .take(count.saturating_sub(1))
                .collect(),
            each: keys.checked_div(count).unwrap_or(keys),
        }
    }

    /// The shard `key` falls to.
    fn of(&self, key: &K) -> &Mutex<Shard<K>> {
        let count = u64::try_from(self.rest.len()).map_or(1, |rest| rest.saturating_add(1));
        let index = self.hasher.hash_one(key).checked_rem(count).unwrap_or(0);
        usize::try_from(index)
            .ok()
            .and_then(|index| self.rest.get(index.checked_sub(1)?))
            .unwrap_or(&self.first)
    }
}

struct Limited<K, C: Clock> {
    clock: C,
    /// The instant every time here counts from.
    start: C::Instant,
    /// What an attempt costs in nanoseconds: `window / max`.
    period: u64,
    /// How far past now a key's arrival time may run and still pass: the other `max - 1` periods.
    tolerance: u64,
    window: u64,
    shards: Shards<K>,
}

/// A rate limit per key: `max` attempts each `window`. A zero `max` or `window` refuses nothing.
pub struct RateLimiter<K: Clone + Eq + Hash, C: Clock = MonotonicClock> {
    limited: Option<Limited<K, C>>,
}

impl<K: Clone + Eq + Hash, C: Clock> fmt::Debug for RateLimiter<K, C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let window = self
            .limited
            .as_ref()
            .map(|limited| Duration::from_nanos(limited.window));
        f.debug_struct("RateLimiter")
            .field("window", &window)
            .finish_non_exhaustive()
    }
}

impl<K: Clone + Eq + Hash> RateLimiter<K> {
    /// `max` attempts per key each `window`, judged on the monotonic clock.
    #[must_use]
    pub fn new(max: u32, window: Duration) -> Self {
        Self::with_clock(max, window, MonotonicClock)
    }
}

impl<K: Clone + Eq + Hash, C: Clock> RateLimiter<K, C> {
    /// `max` attempts per key each `window`, judged on `clock`: a server whose tests move time
    /// gives its own.
    #[must_use]
    pub fn with_clock(max: u32, window: Duration, clock: C) -> Self {
        let limited = NonZeroU32::new(max).and_then(|burst| {
            let period = NonZeroU64::new(nanos(window.checked_div(burst.get())?))?.get();
            let start = clock.now();
            Some(Limited {
                clock,
                start,
                period,
                tolerance: period.saturating_mul(u64::from(burst.get().saturating_sub(1))),
                window: nanos(window),
                shards: Shards::holding(KEYS),
            })
        });
        Self { limited }
    }

    /// This limiter, holding at most `keys` keys rather than [`KEYS`], as it is built.
    #[must_use]
    pub fn holding(mut self, keys: usize) -> Self {
        if let Some(limited) = self.limited.as_mut() {
            limited.shards = Shards::holding(keys.min(KEYS));
        }
        self
    }

    /// Spends one attempt. When the key has none left, refuses with how long until it has one.
    /// # Errors
    /// The wait, when the key has spent its attempts.
    pub fn check(&self, key: &K) -> Result<(), Duration> {
        self.probe(key, true).map_or(Ok(()), Err)
    }

    /// Refuses a key with no attempt left, as `check` does, without spending one: a sign-in that
    /// counts only its failures admits first, then spends when one fails.
    /// # Errors
    pub fn admit(&self, key: &K) -> Result<(), Duration> {
        self.probe(key, false).map_or(Ok(()), Err)
    }

    /// Spends an attempt already made, so it is never refused. A key with none left stays as it
    /// is: an attempt past the limit does not lengthen its wait.
    pub fn spend(&self, key: &K) {
        self.probe(key, true);
    }

    fn probe(&self, key: &K, spends: bool) -> Option<Duration> {
        self.limited.as_ref()?.probe(key, spends)
    }
}

impl<K: Clone + Eq + Hash, C: Clock> Limited<K, C> {
    /// The wait when the key has no attempt left, or a window when it is new to a full shard. The
    /// shard's one lock covers its sweep, room and judgement: no two probes take one last attempt.
    fn probe(&self, key: &K, spends: bool) -> Option<Duration> {
        let now = u64::from(self.clock.now().duration_since(self.start));
        let mut shard = lock(self.shards.of(key));
        shard.sweep(now, self.window, self.period);
        let held = shard.arrivals.get(key).copied();
        if held.is_none() && shard.arrivals.len() >= self.shards.each {
            return Some(Duration::from_nanos(self.window));
        }
        let arrival = held.unwrap_or(now);
        let earliest = arrival.saturating_sub(self.tolerance);
        if now < earliest {
            return Some(Duration::from_nanos(earliest.saturating_sub(now)));
        }
        if spends {
            shard
                .arrivals
                .insert(key.clone(), arrival.max(now).saturating_add(self.period));
        }
        drop(shard);
        None
    }
}

#[cfg(test)]
impl<K> Shards<K> {
    /// Every shard, the first with the rest.
    fn all(&self) -> impl Iterator<Item = &Mutex<Shard<K>>> {
        std::iter::once(&self.first).chain(self.rest.iter())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::hash::Hash;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::num::NonZeroU32;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use governor::Quota;
    use governor::clock::{Clock, FakeRelativeClock, Reference};
    use governor::middleware::NoOpMiddleware;
    use governor::nanos::Nanos;
    use governor::state::StateStore;
    use governor::state::keyed::ShrinkableKeyedStateStore;
    use proptest::prelude::*;

    use super::{KEYS, RateLimiter, SHARD_KEYS, network};
    use crate::sync::lock;

    const MINUTE: Duration = Duration::from_mins(1);

    fn limiter<K: Clone + Eq + Hash>(
        max: u32,
    ) -> (RateLimiter<K, FakeRelativeClock>, FakeRelativeClock) {
        let clock = FakeRelativeClock::default();
        (RateLimiter::with_clock(max, MINUTE, clock.clone()), clock)
    }

    /// The keys `limiter` holds, over all its shards.
    fn held<K: Clone + Eq + Hash>(limiter: &RateLimiter<K, FakeRelativeClock>) -> usize {
        limiter.limited.as_ref().map_or(0, |limited| {
            limited
                .shards
                .all()
                .map(|shard| lock(shard).arrivals.len())
                .sum()
        })
    }

    /// A key, and whether checking it spends an attempt or only looks.
    #[derive(Clone, PartialEq, Eq, Hash)]
    struct Probe<K> {
        key: K,
        spends: bool,
    }

    /// Each key's theoretical arrival time, in one map under one lock, which a look reads and
    /// never writes.
    struct Cells<K>(Arc<Mutex<HashMap<K, Nanos>>>);

    impl<K: Clone + Eq + Hash> StateStore for Cells<K> {
        type Key = Probe<K>;

        fn measure_and_replace<T, F, E>(&self, probe: &Probe<K>, decide: F) -> Result<T, E>
        where
            F: Fn(Option<Nanos>) -> Result<(T, Nanos), E>,
        {
            let mut cells = lock(&self.0);
            let (outcome, next) = decide(cells.get(&probe.key).copied())?;
            if probe.spends {
                cells.insert(probe.key.clone(), next);
            }
            drop(cells);
            Ok(outcome)
        }
    }

    impl<K: Clone + Eq + Hash> ShrinkableKeyedStateStore<Probe<K>> for Cells<K> {
        fn retain_recent(&self, drop_below: Nanos) {
            lock(&self.0).retain(|_, arrival| *arrival > drop_below);
        }

        fn len(&self) -> usize {
            lock(&self.0).len()
        }

        fn is_empty(&self) -> bool {
            lock(&self.0).is_empty()
        }
    }

    /// `governor`'s own rate limiter over one map, `max` a minute, holding at most `keys` keys
    /// and forgetting those back at a fresh state once a minute: the judge the shards answer to.
    struct Governed<K: Clone + Eq + Hash> {
        gcra: governor::RateLimiter<Probe<K>, Cells<K>, FakeRelativeClock, NoOpMiddleware<Nanos>>,
        cells: Arc<Mutex<HashMap<K, Nanos>>>,
        keys: usize,
        swept_at: Mutex<Nanos>,
    }

    impl<K: Clone + Eq + Hash> Governed<K> {
        fn per_minute(max: NonZeroU32, keys: usize, clock: FakeRelativeClock) -> Self {
            let cells = Arc::default();
            let quota = Quota::per_minute(max);
            let gcra = governor::RateLimiter::new(quota, Cells(Arc::clone(&cells)), clock);
            let swept_at = Mutex::new(gcra.clock().now());
            Self {
                gcra,
                cells,
                keys,
                swept_at,
            }
        }

        /// The wait, when `key` has no attempt left, or is new while the map holds all it may.
        fn probe(&self, key: &K, spends: bool) -> Option<Duration> {
            let now = self.gcra.clock().now();
            let mut swept_at = lock(&self.swept_at);
            if now.duration_since(*swept_at) >= MINUTE.into() {
                self.gcra.retain_recent();
                *swept_at = now;
            }
            drop(swept_at);
            let cells = lock(&self.cells);
            let full = cells.len() >= self.keys && !cells.contains_key(key);
            drop(cells);
            if full {
                return Some(MINUTE);
            }
            let probe = Probe {
                key: key.clone(),
                spends,
            };
            let refused = self.gcra.check_key(&probe).err()?;
            Some(refused.wait_time_from(self.gcra.clock().now()))
        }

        /// How many keys the map holds, and whether none.
        fn held(&self) -> (usize, bool) {
            (self.gcra.len(), self.gcra.is_empty())
        }
    }

    #[test]
    fn each_key_spends_its_own_attempts_and_waits_for_the_next() {
        let (limiter, clock) = limiter(3);
        for _ in 0..3 {
            assert_eq!(limiter.check(&"a"), Ok(()));
        }
        assert_eq!(limiter.check(&"a"), Err(Duration::from_secs(20)));
        assert_eq!(limiter.check(&"b"), Ok(()));
        clock.advance(Duration::from_secs(20));
        assert_eq!(limiter.check(&"a"), Ok(()));
        assert!(limiter.check(&"a").is_err());
    }

    #[test]
    fn admitting_spends_nothing_and_spending_is_never_refused() {
        let (limiter, clock) = limiter(2);
        for _ in 0..5 {
            assert_eq!(limiter.admit(&"a"), Ok(()));
        }
        limiter.spend(&"a");
        limiter.spend(&"a");
        assert_eq!(limiter.admit(&"a"), Err(Duration::from_secs(30)));
        limiter.spend(&"a");
        assert_eq!(limiter.admit(&"a"), Err(Duration::from_secs(30)));
        clock.advance(Duration::from_secs(30));
        assert_eq!(limiter.admit(&"a"), Ok(()));
    }

    #[test]
    fn a_zero_max_or_window_refuses_nothing() {
        let none = RateLimiter::new(0, MINUTE);
        let instant = RateLimiter::new(5, Duration::ZERO);
        for _ in 0..100 {
            assert_eq!(none.check(&"a"), Ok(()));
            assert_eq!(instant.check(&"a"), Ok(()));
        }
    }

    /// Looks at keys `a` and `b`, each admitted.
    fn admit_both(limiter: &RateLimiter<&str, FakeRelativeClock>) {
        assert_eq!(limiter.admit(&"a"), Ok(()));
        assert_eq!(limiter.admit(&"b"), Ok(()));
    }

    #[test]
    fn a_shard_forgets_its_keys_back_at_a_fresh_state_once_a_window() {
        let (limiter, clock) = limiter(1);
        assert_eq!(limiter.check(&"a"), Ok(()));
        assert_eq!(limiter.check(&"b"), Ok(()));
        assert_eq!(held(&limiter), 2);
        clock.advance(MINUTE);
        // A look sweeps its key's shard once the shard's window is out.
        admit_both(&limiter);
        assert_eq!(
            held(&limiter),
            2,
            "a key just back at a fresh state is still kept"
        );
        clock.advance(MINUTE);
        admit_both(&limiter);
        assert_eq!(held(&limiter), 0);
        assert!(format!("{limiter:?}").starts_with("RateLimiter"));
    }

    #[test]
    fn an_ipv6_client_counts_by_its_network_and_an_ipv4_one_whole() {
        let v6 = |segments: [u16; 8]| IpAddr::V6(Ipv6Addr::from(segments));
        let home = v6([0x2001, 0xdb8, 1, 2, 0, 0, 0, 0]);
        assert_eq!(network(v6([0x2001, 0xdb8, 1, 2, 0xaaaa, 0, 0, 1])), home);
        assert_eq!(network(v6([0x2001, 0xdb8, 1, 2, 0xffff, 9, 8, 7])), home);
        assert_ne!(network(v6([0x2001, 0xdb8, 1, 3, 0, 0, 0, 1])), home);
        let v4 = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9));
        assert_eq!(network(v4), v4);
        let mapped = IpAddr::V6(Ipv4Addr::new(203, 0, 113, 9).to_ipv6_mapped());
        assert_eq!(network(mapped), v4);
    }

    #[test]
    fn a_full_limiter_has_a_new_key_wait_for_the_sweep_and_keeps_those_it_holds() {
        let (limiter, clock) = limiter(2);
        let limiter = limiter.holding(2);
        assert_eq!(limiter.check(&"a"), Ok(()));
        assert_eq!(limiter.check(&"b"), Ok(()));
        assert_eq!(limiter.check(&"c"), Err(MINUTE));
        assert_eq!(limiter.admit(&"c"), Err(MINUTE));
        assert_eq!(
            limiter.check(&"a"),
            Ok(()),
            "a key it holds keeps its allowance"
        );
        clock.advance(MINUTE.saturating_mul(2));
        assert_eq!(limiter.check(&"c"), Ok(()), "the sweep made room");
    }

    /// Room for two shards makes two, each holding its share: a new key past it waits a window,
    /// the keys held keep their allowance, and a shard's first probe past its window sweeps it.
    #[test]
    fn each_shard_holds_its_share_and_sweeps_itself() {
        let room = SHARD_KEYS.saturating_mul(2);
        let (limiter, clock) = limiter(2);
        let limiter = limiter.holding(room);
        let shards = limiter
            .limited
            .as_ref()
            .map_or(0, |limited| limited.shards.all().count());
        assert_eq!(shards, 2);
        let (passed, refused): (Vec<u32>, Vec<u32>) =
            (0..4_096).partition(|key| limiter.check(key).is_ok());
        assert_eq!(passed.len(), room);
        assert_eq!(held(&limiter), room);
        assert!(refused.iter().all(|key| limiter.admit(key) == Err(MINUTE)));
        assert!(passed.iter().all(|key| limiter.check(key).is_ok()));
        clock.advance(MINUTE.saturating_mul(2));
        let later = (4_096..8_192_u32)
            .filter(|key| limiter.check(key).is_ok())
            .count();
        assert_eq!(later, room, "each shard swept itself as a probe came to it");
        assert_eq!(held(&limiter), room);
    }

    /// Probes from several threads at once take each key's last attempt once: every key passes
    /// its `max` exactly, however the threads interleave.
    #[test]
    fn keys_probed_from_many_threads_pass_exactly_their_max() {
        let (limiter, _clock) = limiter(3);
        let passed: usize = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        (0..10)
                            .flat_map(|_| 0_u8..8)
                            .filter(|key| limiter.check(key).is_ok())
                            .count()
                    })
                })
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap_or(0))
                .sum()
        });
        assert_eq!(passed, 24, "8 keys, 3 attempts each");
    }

    proptest! {
        /// However a key's attempts are spaced, spent or looked at, it never passes its rate: its
        /// `max` at once, then one more each `window / max`.
        #[test]
        fn a_key_never_passes_its_rate(
            max in 1_u32..8,
            steps in prop::collection::vec((0_u64..30_000, 0_u32..6, any::<bool>()), 1..40),
        ) {
            let (limiter, clock) = limiter(max);
            let (mut passed, mut elapsed) = (0_u128, Duration::ZERO);
            for (wait, tries, looks) in steps {
                let wait = Duration::from_millis(wait);
                clock.advance(wait);
                elapsed = elapsed.saturating_add(wait);
                for _ in 0..tries {
                    if looks {
                        // Looking spends nothing, so it never counts against the rate.
                        prop_assert_eq!(limiter.admit(&"a").is_ok(), limiter.admit(&"a").is_ok());
                    } else if limiter.check(&"a").is_ok() {
                        passed = passed.saturating_add(1);
                    }
                }
                let earned = elapsed.as_nanos().saturating_mul(u128::from(max));
                let earned = earned.checked_div(MINUTE.as_nanos()).unwrap_or(0);
                prop_assert!(
                    passed <= u128::from(max).saturating_add(earned),
                    "{passed} passed in {elapsed:?} at {max} a minute"
                );
            }
        }

        /// The shards judge each check, look and spend as `governor` does over one map, at the
        /// default room or room for 0 to 3 keys, where one shard holds just the keys the map does.
        #[test]
        fn the_shards_judge_as_governor_over_one_map_does(
            max in (1_u32..6).prop_filter_map("a max above zero", NonZeroU32::new),
            room in prop::option::of(0_usize..4),
            steps in prop::collection::vec((0_u64..40_000, 0_u8..6, 0_u8..3), 1..80),
        ) {
            let clock = FakeRelativeClock::default();
            let keys = room.unwrap_or(KEYS);
            let sharded = RateLimiter::with_clock(max.get(), MINUTE, clock.clone()).holding(keys);
            let governed = Governed::per_minute(max, keys, clock.clone());
            for (wait, key, act) in steps {
                clock.advance(Duration::from_millis(wait));
                match act {
                    0 => {
                        let judged = governed.probe(&key, true).map_or(Ok(()), Err);
                        prop_assert_eq!(sharded.check(&key), judged);
                    }
                    1 => {
                        let judged = governed.probe(&key, false).map_or(Ok(()), Err);
                        prop_assert_eq!(sharded.admit(&key), judged);
                    }
                    _ => {
                        sharded.spend(&key);
                        governed.probe(&key, true);
                    }
                }
                if room.is_some() {
                    let kept = held(&sharded);
                    prop_assert_eq!((kept, kept == 0), governed.held());
                }
            }
        }
    }
}
