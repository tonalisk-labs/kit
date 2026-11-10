//! A Stripe REST client and its webhook signature check. Replies are read by JSON Pointer, so only
//! the members used are named.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

/// Stripe's own address; a test names its fake instead.
pub const API_BASE: &str = "https://api.stripe.com";
/// The form of a call that sends none.
pub const NO_FORM: &[(&str, &str)] = &[];
/// The API version every request names, so an account upgrade cannot reshape a reply.
const API_VERSION: &str = "2026-06-24.dahlia";
const SIGNATURE_TOLERANCE_SECONDS: i64 = 300;
/// Per-request budget, well inside a backend's own request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How a Stripe call failed. Only an outage is worth the caller's retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StripeError {
    /// Unreachable, rate limited or failing: temporary, and Stripe's to fix.
    Unavailable,
    /// Stripe holds no such object. Whether that is a fault is the caller's to say.
    Missing,
    /// Stripe refused, or answered in a shape this client does not read.
    Refused,
}

/// One account's client. The secret key leaves only in the `Authorization` header.
#[derive(Debug)]
pub struct Stripe {
    http: reqwest::Client,
    api_base: String,
    secret_key: SecretString,
}

impl Stripe {
    /// A client of the API at `api_base`, through `http`.
    #[must_use]
    pub fn new(http: reqwest::Client, api_base: &str, secret_key: SecretString) -> Self {
        let api_base = api_base.trim_end_matches('/').to_owned();
        Self {
            http,
            api_base,
            secret_key,
        }
    }

    /// Calls one endpoint and answers its reply; the status alone sorts a failure.
    /// # Errors
    pub async fn call<K: Serialize + Sync, V: Serialize + Sync>(
        &self,
        method: Method,
        path: &str,
        form: &[(K, V)],
        idempotency: Option<&str>,
    ) -> Result<Value, StripeError> {
        let url = format!("{}{path}", self.api_base);
        let mut request = self.http.request(method, url).timeout(REQUEST_TIMEOUT);
        if !form.is_empty() {
            request = request.form(form);
        }
        if let Some(key) = idempotency {
            request = request.header("Idempotency-Key", key);
        }
        let response = request
            .bearer_auth(self.secret_key.expose_secret())
            .header("Stripe-Version", API_VERSION)
            .send()
            .await
            .map_err(|err| {
                tracing::error!(error = %err, path, "stripe request failed");
                StripeError::Unavailable
            })?;
        let status = response.status();
        let request_id = request_id_of(response.headers());
        let body = response.bytes().await.map_err(|err| {
            tracing::error!(error = %err, path, request_id, "stripe reply was cut short");
            StripeError::Unavailable
        })?;
        // A proxy's error page carries no JSON: its status alone sorts it.
        let reply = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(reply);
        }
        let failure = failure_of(status);
        let said = |member: &str| text(&reply, member).unwrap_or_default();
        let (kind, code) = (said("/error/type"), said("/error/code"));
        let (param, message) = (said("/error/param"), said("/error/message"));
        tracing::error!(%status, path, request_id, kind, code, param, message, ?failure, "stripe error response");
        Err(failure)
    }
}

/// What Stripe support asks for, and what finds the call in its dashboard.
fn request_id_of(headers: &HeaderMap) -> String {
    headers
        .get("request-id")
        .and_then(|id| id.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

/// The failure a status other than success sorts a call into.
fn failure_of(status: StatusCode) -> StripeError {
    match status {
        StatusCode::NOT_FOUND => StripeError::Missing,
        StatusCode::TOO_MANY_REQUESTS => StripeError::Unavailable,
        status if status.is_server_error() => StripeError::Unavailable,
        _ => StripeError::Refused,
    }
}

/// A string member of a reply, by JSON Pointer.
#[must_use]
pub fn text(reply: &Value, pointer: &str) -> Option<String> {
    reply.pointer(pointer)?.as_str().map(str::to_owned)
}

/// A string member a successful reply must have, or `Refused`: this client cannot read it.
/// # Errors
pub fn member(reply: &Value, pointer: &str) -> Result<String, StripeError> {
    text(reply, pointer).ok_or_else(|| {
        tracing::error!(pointer, "stripe reply lacked a member this client reads");
        StripeError::Refused
    })
}

/// Whether `header`, Stripe's `t=...,v1=...`, signs `payload` with `secret`: HMAC-SHA256 over
/// `"{t}.{payload}"` equal to any `v1`, compared in constant time, and `t` within the skew.
#[must_use]
pub fn verify_webhook_signature(payload: &[u8], header: &str, secret: &SecretString) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH);
    let now = now.map_or(0, |since| {
        i64::try_from(since.as_secs()).unwrap_or(i64::MAX)
    });
    signed_at(payload, header, secret, now)
}

fn signed_at(payload: &[u8], header: &str, secret: &SecretString, now: i64) -> bool {
    let field = |name: &'static str| {
        let fields = header.split(',');
        fields.filter_map(move |field| field.trim().strip_prefix(name)?.strip_prefix('='))
    };
    let Some(stamp) = field("t").next() else {
        return false;
    };
    let skew = stamp
        .parse()
        .map(|sent: i64| now.saturating_sub(sent).saturating_abs());
    let keyed = Hmac::<Sha256>::new_from_slice(secret.expose_secret().as_bytes());
    skew.is_ok_and(|skew| skew <= SIGNATURE_TOLERANCE_SECONDS)
        && keyed.is_ok_and(|mut mac| {
            mac.update(stamp.as_bytes());
            mac.update(b".");
            mac.update(payload);
            let mut signatures = field("v1").filter_map(unhex);
            signatures.any(|signature| mac.clone().verify_slice(&signature).is_ok())
        })
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    let (pairs, []) = text.as_bytes().as_chunks::<2>() else {
        return None;
    };
    let digit = |byte: u8| char::from(byte).to_digit(16);
    let byte = |&[high, low]: &[u8; 2]| digit(high)?.checked_mul(16)?.checked_add(digit(low)?);
    pairs
        .iter()
        .map(|pair| u8::try_from(byte(pair)?).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use hmac::{Hmac, KeyInit, Mac};
    use reqwest::Method;
    use reqwest::header::{HeaderMap, HeaderValue};
    use secrecy::SecretString;
    use serde_json::json;
    use sha2::Sha256;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinSet;

    use super::{
        API_VERSION, NO_FORM, SIGNATURE_TOLERANCE_SECONDS, Stripe, StripeError, member,
        request_id_of, signed_at, text, verify_webhook_signature,
    };

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    const SECRET: &str = "whsec_test_secret";
    const NOW: i64 = 1_700_000_000;
    const EDGE: i64 = NOW - SIGNATURE_TOLERANCE_SECONDS;
    const STALE: i64 = EDGE - 1;
    const PAYLOAD: &[u8] = br#"{"id":"evt_test_webhook","object":"event"}"#;
    /// Python's `hmac` over `"1700000000." + PAYLOAD` with `SECRET`, as Stripe signs it.
    const STRIPE_SIGNED: &str = "d95c6b7477fbd7e9f90b1b0ef5f9c7ac25abca5382460e0d988c2b2a5b71b990";

    fn signed(
        timestamp: i64,
        secret: &str,
        payload: &[u8],
    ) -> Result<String, hmac::digest::InvalidLength> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(payload);
        let bytes = mac.finalize().into_bytes();
        let nibbles = bytes.iter().flat_map(|byte| [byte >> 4, byte & 0x0f]);
        Ok(nibbles
            .filter_map(|nibble| char::from_digit(nibble.into(), 16))
            .collect())
    }

    #[test]
    fn a_failed_call_is_logged_with_the_request_id_stripe_answered() {
        let mut headers = HeaderMap::new();
        assert_eq!(request_id_of(&headers), "");
        headers.insert("request-id", HeaderValue::from_static("req_test"));
        assert_eq!(request_id_of(&headers), "req_test");
    }

    #[test]
    fn a_webhook_passes_only_as_stripe_signed_it() -> TestResult {
        let good = signed(NOW, SECRET, PAYLOAD)?;
        let forged = signed(NOW, "other", PAYLOAD)?;
        let edge = signed(EDGE, SECRET, PAYLOAD)?;
        let stale = signed(STALE, SECRET, PAYLOAD)?;
        let retired = signed(NOW, "retired", PAYLOAD)?;
        let empty = signed(NOW, SECRET, b"")?;
        let cases: [(&[u8], String, bool); 10] = [
            (PAYLOAD, format!("t={NOW},v1={STRIPE_SIGNED}"), true),
            (PAYLOAD, format!("t={NOW},v1={good}"), true),
            (br#"{"id":"evt_2"}"#, format!("t={NOW},v1={good}"), false),
            (PAYLOAD, format!("t={NOW},v1={forged}"), false),
            (PAYLOAD, format!("t={EDGE},v1={edge}"), true),
            (PAYLOAD, format!("t={STALE},v1={stale}"), false),
            // A rolled secret's retiring signature beside the new one still passes.
            (PAYLOAD, format!("t={NOW},v1={retired},v1={good}"), true),
            (PAYLOAD, format!("v1={good}"), false),
            (PAYLOAD, format!("t={NOW}"), false),
            // A body that is not UTF-8 is signed as its bytes, never read as an empty text.
            (b"\xff", format!("t={NOW},v1={empty}"), false),
        ];
        let secret = SecretString::from(SECRET);
        for (payload, header, accepted) in cases {
            assert_eq!(
                signed_at(payload, &header, &secret, NOW),
                accepted,
                "{header}"
            );
        }
        Ok(())
    }

    /// A webhook is judged at the moment it arrives: signed now it passes, signed by another
    /// secret it does not.
    #[test]
    fn a_webhook_is_judged_now() -> TestResult {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
        let now = i64::try_from(now.as_secs())?;
        let secret = SecretString::from(SECRET);
        let good = signed(now, SECRET, PAYLOAD)?;
        let forged = signed(now, "other", PAYLOAD)?;
        assert!(verify_webhook_signature(
            PAYLOAD,
            &format!("t={now},v1={good}"),
            &secret
        ));
        assert!(!verify_webhook_signature(
            PAYLOAD,
            &format!("t={now},v1={forged}"),
            &secret
        ));
        Ok(())
    }

    /// A server that answers one request with `status` and `body`, and hands back the request
    /// it read: its head and its form.
    async fn answering(
        status: u16,
        body: &'static str,
    ) -> Result<(String, JoinSet<std::io::Result<String>>), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let mut served = JoinSet::new();
        served.spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut read = Vec::new();
            let mut chunk = [0; 4096];
            // The head, then as much body as it declares.
            loop {
                let count = stream.read(&mut chunk).await?;
                read.extend(chunk.get(..count).unwrap_or_default());
                let text = String::from_utf8_lossy(&read);
                if let Some((head, sent)) = text.split_once("\r\n\r\n") {
                    let declared = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .and_then(|length| length.parse::<usize>().ok())
                        .unwrap_or(0);
                    if sent.len() >= declared || count == 0 {
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} Status\r\ncontent-type: application/json\r\n\
                 request-id: req_test\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).await?;
            Ok(String::from_utf8_lossy(&read).into_owned())
        });
        Ok((base, served))
    }

    fn client(base: &str) -> Stripe {
        Stripe::new(
            reqwest::Client::new(),
            base,
            SecretString::from("sk_test_key"),
        )
    }

    /// A call carries the key, the pinned version, its form and its idempotency key, and reads
    /// a success's reply.
    #[tokio::test]
    async fn a_call_names_its_key_version_and_idempotency_and_reads_the_reply() -> TestResult {
        let (base, mut served) = answering(200, r#"{"id":"cus_1","email":"a@b.test"}"#).await?;
        let form = [("email", "a@b.test")];
        let reply = client(&format!("{base}/"))
            .call(Method::POST, "/v1/customers", &form, Some("idem-1"))
            .await;
        let reply = reply.map_err(|failure| format!("{failure:?}"))?;
        assert_eq!(member(&reply, "/id"), Ok("cus_1".to_owned()));
        assert_eq!(text(&reply, "/email").as_deref(), Some("a@b.test"));
        let request = served
            .join_next()
            .await
            .ok_or("no request")???
            .to_ascii_lowercase();
        assert!(
            request.starts_with("post /v1/customers http/1.1"),
            "{request}"
        );
        assert!(
            request.contains("authorization: bearer sk_test_key"),
            "{request}"
        );
        assert!(request.contains(&format!(
            "stripe-version: {}",
            API_VERSION.to_ascii_lowercase()
        )));
        assert!(request.contains("idempotency-key: idem-1"), "{request}");
        assert!(request.ends_with("email=a%40b.test"), "{request}");
        Ok(())
    }

    /// The status alone sorts a failure: missing, refused, or Stripe's own to fix.
    #[tokio::test]
    async fn a_failure_is_sorted_by_its_status() -> TestResult {
        let error = r#"{"error":{"type":"invalid_request_error","code":"resource_missing"}}"#;
        let cases = [
            (404, error, StripeError::Missing),
            (400, error, StripeError::Refused),
            (402, "{}", StripeError::Refused),
            (429, "{}", StripeError::Unavailable),
            (500, "{}", StripeError::Unavailable),
            (502, "<html>a proxy's page</html>", StripeError::Unavailable),
        ];
        for (status, body, failure) in cases {
            let (base, mut served) = answering(status, body).await?;
            let reply = client(&base)
                .call(Method::GET, "/v1/x", NO_FORM, None)
                .await;
            assert_eq!(reply, Err(failure), "{status}");
            let request = served.join_next().await.ok_or("no request")???;
            assert!(!request.contains("Idempotency-Key"), "{request}");
        }
        Ok(())
    }

    /// No server at all is an outage, and a reply without a member this client reads is refused.
    #[tokio::test]
    async fn no_server_is_an_outage_and_a_missing_member_is_refused() -> TestResult {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        drop(listener);
        let reply = client(&base)
            .call(Method::GET, "/v1/x", NO_FORM, None)
            .await;
        assert_eq!(reply, Err(StripeError::Unavailable));
        assert_eq!(
            member(&json!({ "id": 7 }), "/id"),
            Err(StripeError::Refused)
        );
        assert_eq!(text(&json!({}), "/id"), None);
        Ok(())
    }
}
