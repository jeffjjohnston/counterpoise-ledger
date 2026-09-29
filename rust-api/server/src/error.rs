use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::borrow::Cow;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    message: Cow<'static, str>,
}

impl ApiError {
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub(crate) type ApiResult = Result<Json<Value>, ApiError>;

pub(crate) fn error(status: StatusCode, message: &'static str) -> ApiError {
    ApiError {
        status,
        message: Cow::Borrowed(message),
    }
}

/// A message built from the request, such as a zod "expected X, received Y"
/// issue. Use `error` for a fixed message.
pub(crate) fn error_owned(status: StatusCode, message: String) -> ApiError {
    ApiError {
        status,
        message: Cow::Owned(message),
    }
}

pub(crate) fn internal_error(cause: sqlx::Error, message: &'static str) -> ApiError {
    tracing::error!(error = %cause, "Rust API database request failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, response::IntoResponse};

    use super::{StatusCode, error};

    #[tokio::test]
    async fn error_body_matches_next_handler_shape() {
        let response = error(StatusCode::NOT_FOUND, "Book not found").into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), 1024).await.expect("body");
        assert_eq!(body.as_ref(), br#"{"error":"Book not found"}"#);
    }
}
