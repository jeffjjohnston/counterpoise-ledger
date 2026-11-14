//! The copy of a Durable Object's daily dump in an S3 bucket, outside
//! Cloudflare. If the Cloudflare account is lost, the newest dump in S3 loads
//! into a native file (`ledger-cli load`), and the Docker target serves it.
//!
//! The copy runs only when its four settings ([`SETTINGS`]) are set, which a
//! Worker has as secrets. The access key needs `s3:PutObject` on the bucket
//! and no other permission: this module only writes, and the bucket's own
//! lifecycle rule deletes the old dumps.
//!
//! Each request is a `PUT` that this module signs with AWS Signature
//! Version 4 (HMAC-SHA256). The bucket is in the host name
//! (`<bucket>.s3.<region>.amazonaws.com`), so a bucket name must have no dot:
//! the certificate of S3 covers only one level of name below `s3`.

// Only a Durable Object runs the copy; the tests run natively.
#![cfg_attr(feature = "native", allow(dead_code))]

use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// The settings of the copy: the bucket, its region, and the access key.
pub(crate) const SETTINGS: [&str; 4] = [
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_REGION",
    "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY",
];

/// How long one upload can take. A dump is a few megabytes.
const TIMEOUT: Duration = Duration::from_secs(120);

/// The bytes that the path of a request keeps as they are: the unreserved
/// characters of RFC 3986, and `/`. S3 encodes all the others.
const KEEP: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~')
    .remove(b'/');

/// The bucket that receives the copy, and the key that writes to it. It has
/// no `Debug`, so that no log can show the secret key.
pub(crate) struct Target {
    bucket: String,
    region: String,
    access_key_id: String,
    secret_access_key: String,
}

impl Target {
    /// The target that the settings give. `Ok(None)` when no setting is set:
    /// the copy is off. An error when some are set and the copy cannot run.
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        Self::from_values(|name| ledger_db::env::var(name).ok())
    }

    fn from_values(value: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let values = SETTINGS.map(|name| value(name).filter(|text| !text.trim().is_empty()));
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        if let Some(missing) = values.iter().position(Option::is_none) {
            return Err(format!("{} is not set", SETTINGS[missing]));
        }
        let [bucket, region, access_key_id, secret_access_key] =
            values.map(|text| text.unwrap_or_default().trim().to_owned());
        if !host_label(&bucket) {
            return Err(format!("{} must have only a-z, 0-9 and -", SETTINGS[0]));
        }
        if !host_label(&region) {
            return Err(format!("{} must have only a-z, 0-9 and -", SETTINGS[1]));
        }
        Ok(Some(Self {
            bucket,
            region,
            access_key_id,
            secret_access_key,
        }))
    }

    fn host(&self) -> String {
        format!("{}.s3.{}.amazonaws.com", self.bucket, self.region)
    }
}

/// A name that can be one label of a host name, as this module uses it.
fn host_label(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Writes `body` as the object `key` of the bucket of `target`. A second
/// write of one key replaces the object. The error gives the HTTP status and
/// the S3 error code, never the key or the signature.
pub(crate) async fn put(target: &Target, key: &str, body: Vec<u8>) -> Result<(), String> {
    let host = target.host();
    let path = format!("/{}", utf8_percent_encode(key, KEEP));
    let payload_hash = hex::encode(Sha256::digest(&body));
    let now = crate::platform::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    // Sorted by name, as the canonical request needs them.
    let headers = [
        ("content-type", "application/json".to_owned()),
        ("host", host.clone()),
        ("x-amz-content-sha256", payload_hash.clone()),
        ("x-amz-date", amz_date),
    ];
    let authorization = authorization(target, "PUT", &path, &headers, &payload_hash, now);
    let url = format!("https://{host}{path}");
    let client = crate::platform::http_client();
    crate::platform::outbound(async move {
        // The client sets `host` from the URL, and `fetch` refuses it as a
        // header.
        let mut request = client
            .put(url)
            .timeout(TIMEOUT)
            .header("authorization", authorization)
            .body(body);
        for (name, value) in headers.iter().filter(|(name, _)| *name != "host") {
            request = request.header(*name, value);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "S3 could not be reached".to_owned())?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = response.text().await.unwrap_or_default();
        Err(match error_code(&text) {
            Some(code) => format!("S3 answered {} ({code})", status.as_u16()),
            None => format!("S3 answered {}", status.as_u16()),
        })
    })
    .await
}

/// The `<Code>` of an S3 error body, if it has one that is short and plain.
fn error_code(body: &str) -> Option<&str> {
    let start = body.find("<Code>")? + "<Code>".len();
    let length = body[start..].find("</Code>")?;
    let code = &body[start..start + length];
    (!code.is_empty() && code.len() <= 64 && code.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .then_some(code)
}

/// The `Authorization` header of a request to S3 with no query string.
/// `headers` are the signed headers: lowercase names in sorted order, with
/// their values. `path` is the encoded path.
fn authorization(
    target: &Target,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
    now: DateTime<Utc>,
) -> String {
    let day = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let scope = format!("{day}/{}/s3/aws4_request", target.region);
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request =
        format!("{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let key = [day.as_str(), &target.region, "s3", "aws4_request"]
        .iter()
        .fold(
            format!("AWS4{}", target.secret_access_key).into_bytes(),
            |key, part| hmac(&key, part.as_bytes()),
        );
    let signature = hex::encode(hmac(&key, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        target.access_key_id
    )
}

fn hmac(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn target(region: &str) -> Target {
        Target {
            bucket: "examplebucket".to_owned(),
            region: region.to_owned(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned(),
        }
    }

    /// The "PUT Object" example of the AWS documentation, "Signature
    /// Calculations for the Authorization Header: Transferring Payload in a
    /// Single Chunk".
    #[test]
    fn the_signature_is_the_one_of_the_aws_put_object_example() {
        let payload_hash = hex::encode(Sha256::digest(b"Welcome to Amazon S3."));
        assert_eq!(
            payload_hash,
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
        let headers = [
            ("date", "Fri, 24 May 2013 00:00:00 GMT".to_owned()),
            ("host", "examplebucket.s3.amazonaws.com".to_owned()),
            ("x-amz-content-sha256", payload_hash.clone()),
            ("x-amz-date", "20130524T000000Z".to_owned()),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY".to_owned()),
        ];
        let path = format!("/{}", utf8_percent_encode("test$file.text", KEEP));
        assert_eq!(path, "/test%24file.text");
        let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
        assert_eq!(
            authorization(
                &target("us-east-1"),
                "PUT",
                &path,
                &headers,
                &payload_hash,
                now
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, \
             Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn the_copy_is_off_with_no_setting_and_refused_with_some() {
        let none = |_: &str| None;
        assert!(matches!(Target::from_values(none), Ok(None)));
        let blank = |_: &str| Some(" ".to_owned());
        assert!(matches!(Target::from_values(blank), Ok(None)));

        let all = |name: &str| {
            Some(match name {
                "BACKUP_S3_BUCKET" => "counterpoise-backup".to_owned(),
                "BACKUP_S3_REGION" => "us-east-2".to_owned(),
                other => format!("value of {other}"),
            })
        };
        let target = Target::from_values(all).unwrap().unwrap();
        assert_eq!(
            target.host(),
            "counterpoise-backup.s3.us-east-2.amazonaws.com"
        );

        let no_secret = |name: &str| {
            (name != "BACKUP_S3_SECRET_ACCESS_KEY")
                .then(|| all(name))
                .flatten()
        };
        assert_eq!(
            Target::from_values(no_secret).err().unwrap(),
            "BACKUP_S3_SECRET_ACCESS_KEY is not set"
        );
        let dotted = |name: &str| match name {
            "BACKUP_S3_BUCKET" => Some("my.bucket".to_owned()),
            other => all(other),
        };
        assert_eq!(
            Target::from_values(dotted).err().unwrap(),
            "BACKUP_S3_BUCKET must have only a-z, 0-9 and -"
        );
    }

    #[test]
    fn an_error_gives_only_a_plain_code() {
        let body = "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code>\
                    <Message>Access Denied</Message></Error>";
        assert_eq!(error_code(body), Some("AccessDenied"));
        assert_eq!(error_code("<Code><script></Code>"), None);
        assert_eq!(error_code("not xml"), None);
    }

    /// Writes one object to a real bucket: run it by hand with the four
    /// settings in the environment, to check the bucket, the policy and the
    /// key. The object is `counterpoise-selftest.json`, which the bucket's
    /// lifecycle rule deletes.
    #[tokio::test]
    #[ignore = "writes to a real S3 bucket"]
    async fn a_put_reaches_the_configured_bucket() {
        let target = Target::from_env()
            .expect("the settings are complete")
            .expect("the settings are set");
        put(&target, "counterpoise-selftest.json", b"{}".to_vec())
            .await
            .unwrap();
    }
}
