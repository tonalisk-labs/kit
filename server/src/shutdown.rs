//! Stopping a server: the signals that begin it, and the deadline that bounds its drain.

use std::pin::Pin;

use tokio::time::Sleep;

/// Runs `work` until `grace` ends, answering `None` when time ran out first.
pub async fn within<F: Future>(grace: Pin<&mut Sleep>, work: F) -> Option<F::Output> {
    tokio::select! {
        output = work => Some(output),
        () = grace => None,
    }
}

/// Installs the SIGINT and SIGTERM handlers now, not on first poll, so a stop sent once a server
/// is ready drains it, and resolves on either; a signal with no handler installed never fires.
#[cfg(unix)]
pub fn stop_signal() -> impl Future<Output = ()> {
    use tokio::signal::unix::{Signal, SignalKind, signal};
    let heard = async |installed: std::io::Result<Signal>| match installed {
        Ok(mut received) => drop(received.recv().await),
        Err(_) => std::future::pending::<()>().await,
    };
    let interrupt = heard(signal(SignalKind::interrupt()));
    let terminate = heard(signal(SignalKind::terminate()));
    async {
        tokio::select! {
            () = interrupt => {},
            () = terminate => {},
        }
    }
}

/// Resolves on Ctrl-C; a handler that cannot be installed never fires.
#[cfg(not(unix))]
pub async fn stop_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::time::Duration;

    use tokio::time::sleep;

    use super::{stop_signal, within};

    #[tokio::test(start_paused = true)]
    async fn work_done_in_time_is_answered_and_late_work_is_not() {
        assert_eq!(
            within(pin!(sleep(Duration::from_secs(5))), async { 7 }).await,
            Some(7)
        );
        let late = within(pin!(sleep(Duration::ZERO)), std::future::pending::<()>()).await;
        assert_eq!(late, None);
    }

    /// The handler is armed when the future is made, so a SIGTERM sent before its first poll stops
    /// it, and the process lives on; the real-clock 5 s bound is for the kernel's delivery alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_terminate_sent_before_the_first_poll_is_heard()
    -> Result<(), Box<dyn std::error::Error>> {
        let stop = stop_signal();
        let status = std::process::Command::new("kill")
            .args(["-TERM", &std::process::id().to_string()])
            .status()?;
        assert!(status.success());
        within(pin!(sleep(Duration::from_secs(5))), stop)
            .await
            .ok_or("the signal was not heard")?;
        Ok(())
    }
}
