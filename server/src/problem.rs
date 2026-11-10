//! Refusals as RFC 9457 problem details: the body each one carries, and the response that sends
//! it. A server keeps its own problem types and the URIs that name them.

use std::time::Duration;

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

/// Problem details' media type.
pub const MEDIA_TYPE: &str = "application/problem+json";

/// One invalid member of a request, located by a JSON Pointer (RFC 6901).
#[derive(Debug, Serialize, ToSchema)]
pub struct InvalidMember {
    /// JSON Pointer to the member within the request body.
    ///
    /// Empty for the whole body. A header or a query parameter is named instead, as
    /// `header:<name>` or `query:<name>`.
    pub pointer: String,
    /// What is wrong with it.
    pub detail: String,
}

impl InvalidMember {
    /// The member at `pointer`, and what is wrong with it.
    #[must_use]
    pub fn new(pointer: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            pointer: pointer.into(),
            detail: detail.into(),
        }
    }
}

/// RFC 9457 problem details payload.
#[derive(Debug, Serialize, ToSchema)]
pub struct Problem {
    /// Problem type URI, which resolves to its documentation.
    ///
    /// Absent means `about:blank`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    pub type_uri: Option<String>,
    /// HTTP status code.
    pub status: u16,
    /// Short summary of the problem type.
    ///
    /// For `about:blank`, the status phrase.
    pub title: String,
    /// Explanation specific to this occurrence, written to help correct the request.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    pub detail: Option<String>,
    /// The invalid members of the request.
    ///
    /// Present on a `validation` problem.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<InvalidMember>,
}

impl Problem {
    /// A problem of no particular type, `about:blank`, titled by its status's phrase.
    #[must_use]
    pub fn untyped(status: StatusCode) -> Self {
        let title = status.canonical_reason().unwrap_or("Error");
        Self::new(None, status, title)
    }

    /// A problem of the type `type_uri` names, under that type's `title`.
    #[must_use]
    pub fn typed(type_uri: String, status: StatusCode, title: &str) -> Self {
        Self::new(Some(type_uri), status, title)
    }

    fn new(type_uri: Option<String>, status: StatusCode, title: &str) -> Self {
        Self {
            type_uri,
            status: status.as_u16(),
            title: title.to_owned(),
            detail: None,
            errors: Vec::new(),
        }
    }

    /// This problem, explained for this occurrence.
    #[must_use]
    pub fn detailed(self, detail: Option<String>) -> Self {
        Self { detail, ..self }
    }

    /// This problem, with the request's invalid members.
    #[must_use]
    pub fn with_errors(self, errors: Vec<InvalidMember>) -> Self {
        Self { errors, ..self }
    }

    /// The response: the problem's status, its media type, and `Retry-After` after `wait`.
    #[must_use]
    pub fn respond(self, wait: Option<Duration>) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let media_type = HeaderValue::from_static(MEDIA_TYPE);
        let mut response =
            (status, [(header::CONTENT_TYPE, media_type)], Json(self)).into_response();
        if let Some(wait) = wait {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry_after(wait));
        }
        response
    }
}

/// `Retry-After` for `wait`, in whole seconds rounded up and at least one: a client told to come
/// back a second early is refused again.
#[must_use]
pub fn retry_after(wait: Duration) -> HeaderValue {
    let seconds = u64::try_from(wait.as_millis().div_ceil(1000)).unwrap_or(u64::MAX);
    seconds.max(1).into()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::{HeaderValue, StatusCode};
    use serde_json::{Value, json};

    use super::{InvalidMember, Problem, retry_after};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    async fn body(
        problem: Problem,
        wait: Option<Duration>,
    ) -> Result<(StatusCode, Option<HeaderValue>, Value), Box<dyn std::error::Error>> {
        let response = problem.respond(wait);
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .map(HeaderValue::as_bytes),
            Some(&b"application/problem+json"[..])
        );
        let waited = response.headers().get("retry-after").cloned();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
        Ok((status, waited, serde_json::from_slice(&bytes)?))
    }

    #[tokio::test]
    async fn an_untyped_problem_is_titled_by_its_status_and_says_nothing_else() -> TestResult {
        let (status, waited, sent) = body(Problem::untyped(StatusCode::NOT_FOUND), None).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(waited, None);
        assert_eq!(sent, json!({ "status": 404, "title": "Not Found" }));
        Ok(())
    }

    #[tokio::test]
    async fn a_typed_problem_carries_its_type_detail_members_and_wait() -> TestResult {
        let problem = Problem::typed(
            "tag:example.com,2026:validation".to_owned(),
            StatusCode::BAD_REQUEST,
            "The request is not valid",
        )
        .detailed(Some("Look again.".to_owned()))
        .with_errors(vec![InvalidMember::new("/name", "is empty")]);
        let (status, waited, sent) = body(problem, Some(Duration::from_millis(1200))).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(waited, Some(HeaderValue::from_static("2")));
        assert_eq!(
            sent,
            json!({
                "type": "tag:example.com,2026:validation",
                "status": 400,
                "title": "The request is not valid",
                "detail": "Look again.",
                "errors": [{ "pointer": "/name", "detail": "is empty" }],
            })
        );
        Ok(())
    }

    #[test]
    fn a_wait_rounds_up_to_whole_seconds_and_never_to_zero() {
        assert_eq!(retry_after(Duration::ZERO), "1");
        assert_eq!(retry_after(Duration::from_millis(1)), "1");
        assert_eq!(retry_after(Duration::from_secs(60)), "60");
        assert_eq!(retry_after(Duration::from_millis(60_001)), "61");
        assert_eq!(retry_after(Duration::MAX), u64::MAX.to_string().as_str());
    }
}
