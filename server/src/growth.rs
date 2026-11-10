//! How work grows with its input, in this thread's processor time.
//!
//! The same work runs at a size and at a fifth of it, timed in pairs, one run of each side by
//! side. A busy machine's processor time for the same work varies from run to run as the thread
//! moves between cores, but a pair's two runs mostly share one, so their ratio holds, and the
//! median of a few pairs drops a pair that straddled a move. Work linear in the size takes about
//! five times as long at it; work that doesn't grow with it, about as long.

use std::error::Error;
use std::fmt;
use std::time::Duration;

use cpu_time::ThreadTime;

/// What a run or its making may fail with.
pub type Failure = Box<dyn Error>;

/// The most a ratio may reach for work that doesn't grow with its input: well short of a linear
/// cost's five, with room for caches that start colder on a larger input.
pub const FLAT: f64 = 2.5;

/// How many times the larger size is the smaller.
pub const TIMES: u32 = 5;

/// How many pairs of runs a reading takes: an odd number, so one ratio is the median.
const PAIRS: usize = 5;

/// How work grew from a fifth of its size to the whole.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Growth {
    /// The median of the pairs' ratios, each a run at the size over one at a fifth of it.
    pub ratio: f64,
    /// The least a run at the size took.
    pub large: Duration,
}

impl fmt::Display for Growth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{:.2} times as long at the size as at a fifth of it, {:?} at the least",
            self.ratio, self.large
        )
    }
}

/// One run's processor time. The run keeps the state it was made from until it is timed, so what
/// letting that state go costs is never counted.
fn timed<Run>(mut run: Run) -> Result<Duration, Failure>
where
    Run: FnMut() -> Result<(), Failure>,
{
    let start = ThreadTime::try_now()?;
    run()?;
    let spent = start.try_elapsed()?;
    drop(run);
    Ok(spent)
}

/// How the work `prepare(size)` makes ready grows from a fifth of `size` to `size`.
///
/// # Errors
///
/// When the work or its making fails, or the kernel gives no processor time.
pub fn growth<Prepare, Run>(size: u32, mut prepare: Prepare) -> Result<Growth, Failure>
where
    Prepare: FnMut(u32) -> Result<Run, Failure>,
    Run: FnMut() -> Result<(), Failure>,
{
    let fifth = size.checked_div(TIMES).unwrap_or(0);
    let mut ratios = Vec::with_capacity(PAIRS);
    let mut large = Duration::MAX;
    for _ in 0..PAIRS {
        let small = timed(prepare(fifth)?)?;
        let whole = timed(prepare(size)?)?;
        large = large.min(whole);
        let floor = Duration::from_micros(1);
        ratios.push(whole.as_secs_f64() / small.max(floor).as_secs_f64());
    }
    ratios.sort_by(f64::total_cmp);
    let ratio = ratios
        .get(PAIRS.checked_div(2).unwrap_or(0))
        .copied()
        .ok_or("no pairs were timed")?;
    Ok(Growth { ratio, large })
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::time::Duration;

    use super::{FLAT, Failure, growth};

    /// A sum of `size` numbers, whose cost is linear in it.
    fn summed(size: u32) -> impl FnMut() -> Result<(), Failure> {
        move || {
            let sum = (0..size).fold(0_u64, |sum, n| sum.wrapping_add(black_box(u64::from(n))));
            black_box(sum);
            Ok(())
        }
    }

    #[test]
    fn linear_work_grows_with_its_size_and_fixed_work_does_not() -> Result<(), Failure> {
        let linear = growth(500_000, |size| Ok(summed(size)))?;
        assert!(linear.ratio > FLAT, "{linear}");
        assert!(
            linear.large > Duration::ZERO && linear.large < Duration::MAX,
            "{linear}"
        );
        let fixed = growth(500_000, |_| Ok(summed(100_000)))?;
        assert!(fixed.ratio < FLAT, "{fixed}");
        assert!(
            fixed
                .to_string()
                .contains(" times as long at the size as at a fifth of it, ")
        );
        Ok(())
    }

    #[test]
    fn a_run_that_fails_fails_the_reading() {
        let failing = growth(10, |_| Ok(|| Err(Failure::from("the work failed"))));
        assert_eq!(
            failing.map_err(|error| error.to_string()),
            Err("the work failed".to_owned())
        );
    }
}
