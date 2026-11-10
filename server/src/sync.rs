//! Locks that a panic elsewhere never poisons.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `mutex`, taking its value even when a holder panicked. Meant for values that are only
/// ever replaced whole, which a panic cannot leave half-written.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::lock;

    #[test]
    fn a_value_stays_reachable_after_a_holder_panics() {
        let shared = Arc::new(Mutex::new(1));
        let holder = Arc::clone(&shared);
        let panicked = std::thread::spawn(move || {
            let _held = lock(&holder);
            std::panic::resume_unwind(Box::new("a holder fails"));
        })
        .join();
        assert!(panicked.is_err());
        assert!(shared.is_poisoned());
        *lock(&shared) = 2;
        assert_eq!(*lock(&shared), 2);
    }
}
