//! Typed request bodies. One struct is the validator of a body and the
//! source of its schema in the API contract.
//!
//! A body struct derives `Deserialize` and `ToSchema`. A field type that
//! carries a rule (`NonBlank`, `NonEmpty`, `IntRange`, `PositiveInt`, an enum from
//! `string_enum!`, `Nullable`) refuses a bad value when serde reads it, and writes the keyword of the same rule into the schema. Thus
//! the rule has one home.
//!
//! THE SHAPE OF THE CONTRACT. A client's generated types follow the shape of
//! a schema, so a derived schema must have the shape that `openapi/dsl.rs`
//! writes:
//! - Do not put a doc comment on the struct: the derive makes it the
//!   `description` of the object. Use `//` there. A doc comment on a field is
//!   the `description` of the property.
//! - A field that a client can leave out is `Option<T>` with
//!   `#[schema(nullable = false)]`. Without the attribute the derive adds
//!   `null` to the type.
//! - The derive writes `format: int32` for a plain `i32`. Use `IntRange`, or
//!   write the schema of the field type by hand, as the types here do.
//! - A field of such a type has `#[schema(inline)]`: the contract has no
//!   component for it. The derive then writes `allOf` of the type's schema
//!   and the description. `schema_of` folds the two into one schema, so get
//!   the schema of a body from `schema_of`, not from `T::schema()`.
//! - The derive does not take a generic type of this crate as the type of a
//!   field. Give it an alias: see `NullablePositiveInt`.
//! - Make an enum with `string_enum!`, not with the two derives: a derived
//!   enum puts its doc comment in the contract, and serde's message for a
//!   bad value does not name the texts.
//!
//! `npm run openapi:check` fails when a struct changes the contract.

use crate::error::{ApiError, error, error_owned};
use crate::validation::is_js_whitespace;
use axum::http::StatusCode;
use serde::Deserialize;
use serde::de::{
    DeserializeOwned, DeserializeSeed, Deserializer, Error as _, MapAccess,
    value::{BorrowedStrDeserializer, MapAccessDeserializer},
};
use serde_json::Value;
use utoipa::{
    Number, PartialSchema, ToSchema,
    openapi::{
        RefOr,
        schema::{AnyOfBuilder, ObjectBuilder, Schema, Type},
    },
};

/// Text with the white space at its two ends removed, and not empty after
/// that. In the schema: a string with `minLength` 1.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NonBlank(String);

impl NonBlank {
    pub(crate) fn into_string(self) -> String {
        self.0
    }
}

impl<'de> Deserialize<'de> for NonBlank {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        // The white space of JavaScript, as the web client trims: U+FEFF is
        // white space and U+0085 is not.
        let trimmed = text.trim_matches(is_js_whitespace);
        if trimmed.is_empty() {
            return Err(D::Error::custom("must not be blank"));
        }
        Ok(Self(trimmed.to_owned()))
    }
}

impl PartialSchema for NonBlank {
    fn schema() -> RefOr<Schema> {
        ObjectBuilder::new()
            .schema_type(Type::String)
            .min_length(Some(1))
            .into()
    }
}

impl ToSchema for NonBlank {}

/// Text that is not empty. It is not trimmed: a password can start or end
/// with a space. In the schema: a string with `minLength` 1.
pub(crate) struct NonEmpty(String);

impl NonEmpty {
    pub(crate) fn into_string(self) -> String {
        self.0
    }
}

impl<'de> Deserialize<'de> for NonEmpty {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() {
            return Err(D::Error::custom("must not be empty"));
        }
        Ok(Self(text))
    }
}

impl PartialSchema for NonEmpty {
    fn schema() -> RefOr<Schema> {
        NonBlank::schema()
    }
}

impl ToSchema for NonEmpty {}

/// The finite number that a value is, or `None` for a value of another type
/// and for a number outside the range of a double.
///
/// A field type that has its own message reads any value first and applies
/// its rule after. If it asked serde for a number and replaced each error
/// with its message, it would also replace serde's "missing field" error,
/// which arrives through the same call when a required field is not there.
fn number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Ok(Value::deserialize(deserializer)?
        .as_f64()
        .filter(|value| value.is_finite()))
}

/// An integer from `MIN` to `MAX`, the two ends included. In the schema: an
/// integer with `minimum` and `maximum`, and no `format`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct IntRange<const MIN: i32, const MAX: i32>(i32);

impl<const MIN: i32, const MAX: i32> IntRange<MIN, MAX> {
    pub(crate) fn get(&self) -> i32 {
        self.0
    }
}

impl<'de, const MIN: i32, const MAX: i32> Deserialize<'de> for IntRange<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let refused = || D::Error::custom(format!("must be an integer from {MIN} to {MAX}"));
        // JSON has one number type, so `45.0` is the integer 45: a client
        // that holds the value as a double writes it so. Each i32 is exact
        // in an f64. Text, a fraction and a number outside the range get
        // the same message.
        match number(deserializer)? {
            Some(value)
                if value.fract() == 0.0 && value >= f64::from(MIN) && value <= f64::from(MAX) =>
            {
                Ok(Self(value as i32))
            }
            _ => Err(refused()),
        }
    }
}

impl<const MIN: i32, const MAX: i32> PartialSchema for IntRange<MIN, MAX> {
    fn schema() -> RefOr<Schema> {
        let bound = |value: i32| Number::Int(value as isize);
        ObjectBuilder::new()
            .schema_type(Type::Integer)
            .minimum(Some(bound(MIN)))
            .maximum(Some(bound(MAX)))
            .into()
    }
}

impl<const MIN: i32, const MAX: i32> ToSchema for IntRange<MIN, MAX> {}

/// An enum that a body holds as one of a fixed set of texts. In the schema:
/// a string with `enum`. A refusal names the texts.
///
/// ```ignore
/// string_enum! {
///     /// A doc comment here is safe: it does not reach the contract.
///     pub(crate) enum SecurityType { Etf = "etf", MutualFund = "mutual_fund" }
/// }
/// ```
macro_rules! string_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        $vis enum $name {
            $($variant),+
        }

        impl $name {
            const TEXTS: &'static [&'static str] = &[$($text),+];

            $vis fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let refused = || {
                    <D::Error as serde::de::Error>::custom(format!(
                        "must be one of: {}",
                        Self::TEXTS.join(", ")
                    ))
                };
                // Read any value, then apply the rule: see `number`.
                match serde_json::Value::deserialize(deserializer)?.as_str() {
                    $(Some($text) => Ok(Self::$variant),)+
                    _ => Err(refused()),
                }
            }
        }

        impl utoipa::PartialSchema for $name {
            fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
                utoipa::openapi::schema::ObjectBuilder::new()
                    .schema_type(utoipa::openapi::schema::Type::String)
                    .enum_values(Some(Self::TEXTS.iter().copied()))
                    .into()
            }
        }

        impl utoipa::ToSchema for $name {}
    };
}
pub(crate) use string_enum;

/// The largest integer that a JavaScript client holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// An integer above zero that a JavaScript client holds exactly. In the
/// schema: an integer with `exclusiveMinimum` 0.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PositiveInt(i64);

impl PositiveInt {
    pub(crate) fn get(&self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PositiveInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let refused = || D::Error::custom("must be a positive integer");
        // See `IntRange`: `5.0` is the integer 5. Each integer up to
        // `MAX_SAFE_INTEGER` is exact in an f64.
        match number(deserializer)? {
            Some(value) if value.fract() == 0.0 && value > 0.0 && value <= MAX_SAFE_INTEGER => {
                Ok(Self(value as i64))
            }
            _ => Err(refused()),
        }
    }
}

impl PartialSchema for PositiveInt {
    fn schema() -> RefOr<Schema> {
        ObjectBuilder::new()
            .schema_type(Type::Integer)
            .exclusive_minimum(Some(Number::Int(0)))
            .into()
    }
}

impl ToSchema for PositiveInt {}

/// A value, or JSON `null`. In the schema: `anyOf` the schema of the value
/// and `null`.
///
/// `Option<Nullable<T>>` with `present` keeps three cases apart: the field is
/// not there, the field is `null`, the field has a value. An update needs
/// them: `null` removes a stored value, and a field that is not there keeps
/// it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Nullable<T> {
    Null,
    Value(T),
}

impl<T> Nullable<T> {
    pub(crate) fn into_option(self) -> Option<T> {
        match self {
            Self::Null => None,
            Self::Value(value) => Some(value),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(|value| value.map_or(Self::Null, Self::Value))
    }
}

impl<T: PartialSchema> PartialSchema for Nullable<T> {
    fn schema() -> RefOr<Schema> {
        let null = ObjectBuilder::new().schema_type(Type::Null);
        Schema::AnyOf(AnyOfBuilder::new().item(T::schema()).item(null).build()).into()
    }
}

impl<T: ToSchema> ToSchema for Nullable<T> {}

/// utoipa's derive does not take a generic type of this crate as the type of
/// a field, and its `schema_with` drops the description. A name without a
/// parameter is a type that the derive takes: give each `Nullable<T>` in use
/// an alias here.
pub(crate) type NullablePositiveInt = Nullable<PositiveInt>;

/// The schema of a body struct, in the shape of the contract.
pub(crate) fn schema_of<T: PartialSchema>() -> RefOr<Schema> {
    let mut schema = T::schema();
    if let RefOr::T(Schema::Object(object)) = &mut schema {
        for property in object.properties.values_mut() {
            fold_description(property);
        }
    }
    schema
}

/// `allOf [X, { description }]`, which the derive writes for an inline field
/// with a doc comment, becomes X with the description.
fn fold_description(property: &mut RefOr<Schema>) {
    let RefOr::T(Schema::AllOf(all_of)) = property else {
        return;
    };
    let [RefOr::T(inner), RefOr::T(Schema::Object(note))] = all_of.items.as_slice() else {
        return;
    };
    let mut folded = inner.clone();
    match &mut folded {
        Schema::Object(object) => object.description.clone_from(&note.description),
        Schema::AnyOf(any_of) => any_of.description.clone_from(&note.description),
        _ => return,
    }
    *property = RefOr::T(folded);
}

/// For a field that a client can leave out but must not send as `null`:
/// `#[serde(default, deserialize_with = "present")]`. Plain serde reads
/// `null` into an `Option` as `None`, the same as a field that is not there.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Reads a JSON object into a body struct. A failure is a 400, and its
/// message starts with the name of the field that was refused. A key that
/// the struct does not name is ignored.
pub(crate) fn typed_body<T: DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    let Value::Object(object) = body else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "The request body must be a JSON object",
        ));
    };
    let fields = Fields {
        entries: object.iter(),
        current: None,
    };
    T::deserialize(MapAccessDeserializer::new(fields))
        .map_err(|cause: serde_json::Error| error_owned(StatusCode::BAD_REQUEST, cause.to_string()))
}

/// The fields of the object, one at a time. It puts the field name in front
/// of an error from the value, which serde alone does not do.
struct Fields<'a> {
    entries: serde_json::map::Iter<'a>,
    current: Option<(&'a String, &'a Value)>,
}

impl<'de> MapAccess<'de> for Fields<'de> {
    type Error = serde_json::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        self.current = self.entries.next();
        self.current
            .map(|(key, _)| seed.deserialize(BorrowedStrDeserializer::new(key)))
            .transpose()
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> Result<V::Value, Self::Error> {
        let (key, value) = self.current.take().expect("a key comes before its value");
        seed.deserialize(value)
            .map_err(|cause| serde_json::Error::custom(format!("{key}: {cause}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        IntRange, NonBlank, Nullable, NullablePositiveInt, present, schema_of, typed_body,
    };
    use axum::http::StatusCode;
    use serde::Deserialize;
    use serde_json::{Value, json};
    use utoipa::ToSchema;

    // No doc comment here: see the module text.
    #[derive(Debug, Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct Sample {
        /// The name.
        #[schema(inline)]
        name: NonBlank,
        /// The days.
        #[serde(default, deserialize_with = "present")]
        #[schema(inline, nullable = false)]
        upcoming_days: Option<IntRange<1, 365>>,
        /// The price.
        #[serde(default, deserialize_with = "present")]
        #[schema(inline, nullable = false)]
        price: Option<NullablePositiveInt>,
    }

    super::string_enum! {
        /// A doc comment on the enum does not reach the schema.
        enum Kind { Etf = "etf", MutualFund = "mutual_fund" }
    }

    #[derive(Debug, Deserialize, ToSchema)]
    struct Kinded {
        #[schema(inline)]
        kind: Kind,
    }

    #[derive(Debug, Deserialize)]
    struct Required {
        #[allow(dead_code)]
        days: IntRange<1, 365>,
        #[allow(dead_code)]
        price: super::PositiveInt,
    }

    /// A field type with its own message does not hide that the field is
    /// not there.
    #[test]
    fn a_required_field_that_is_not_there_is_named() {
        let message = |body: Value| {
            typed_body::<Required>(&body)
                .unwrap_err()
                .message()
                .to_owned()
        };
        assert_eq!(message(json!({"price": 1})), "missing field `days`");
        assert_eq!(message(json!({"days": 1})), "missing field `price`");
        assert_eq!(
            typed_body::<Kinded>(&json!({})).unwrap_err().message(),
            "missing field `kind`"
        );
    }

    #[test]
    fn a_string_enum_reads_its_texts_and_names_them_in_a_refusal() {
        let kind = |body: Value| typed_body::<Kinded>(&body).map(|body| body.kind);
        assert_eq!(
            kind(json!({"kind": "mutual_fund"})).unwrap(),
            Kind::MutualFund
        );
        assert_eq!(Kind::MutualFund.as_str(), "mutual_fund");
        for bad in [json!("MutualFund"), json!("ETF"), json!(null), json!(1)] {
            assert_eq!(
                kind(json!({"kind": bad})).unwrap_err().message(),
                "kind: must be one of: etf, mutual_fund"
            );
        }
        assert_eq!(
            serde_json::to_value(schema_of::<Kinded>()).unwrap(),
            json!({
                "type": "object",
                "required": ["kind"],
                "properties": {"kind": {"type": "string", "enum": ["etf", "mutual_fund"]}}
            })
        );
    }

    fn refusal(body: Value) -> String {
        let error = typed_body::<Sample>(&body).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST, "{body}");
        error.message().to_owned()
    }

    #[test]
    fn a_body_reads_its_fields_and_ignores_the_others() {
        let sample: Sample =
            typed_body(&json!({"name": "  Ledger ", "upcomingDays": 7, "bookId": 9})).unwrap();
        assert_eq!(sample.name.into_string(), "Ledger");
        assert_eq!(sample.upcoming_days.unwrap().get(), 7);
        let sample: Sample = typed_body(&json!({"name": "A"})).unwrap();
        assert_eq!(sample.upcoming_days, None);
    }

    #[test]
    fn a_refusal_names_the_field() {
        for (body, message) in [
            (json!({}), "missing field `name`"),
            (json!({"name": " \t"}), "name: must not be blank"),
            (
                json!({"name": 5}),
                "name: invalid type: number, expected a string",
            ),
            (
                json!({"name": "A", "upcomingDays": 0}),
                "upcomingDays: must be an integer from 1 to 365",
            ),
            (
                json!({"name": "A", "upcomingDays": 366}),
                "upcomingDays: must be an integer from 1 to 365",
            ),
            (
                json!({"name": "A", "upcomingDays": 1.5}),
                "upcomingDays: must be an integer from 1 to 365",
            ),
            (
                json!({"name": "A", "upcomingDays": "7"}),
                "upcomingDays: must be an integer from 1 to 365",
            ),
            // `present`: null is not the same as a field that is not there.
            (
                json!({"name": "A", "upcomingDays": null}),
                "upcomingDays: must be an integer from 1 to 365",
            ),
            (json!(null), "The request body must be a JSON object"),
            (json!(["name"]), "The request body must be a JSON object"),
        ] {
            assert_eq!(refusal(body), message);
        }
    }

    #[test]
    fn the_ends_of_a_range_are_in_it() {
        for days in [1, 365] {
            let sample: Sample = typed_body(&json!({"name": "A", "upcomingDays": days})).unwrap();
            assert_eq!(sample.upcoming_days.unwrap().get(), days);
        }
        // An integer that a client wrote with a fraction part of zero.
        let body = serde_json::from_str(r#"{"name":"A","upcomingDays":45.0}"#).unwrap();
        let sample: Sample = typed_body(&body).unwrap();
        assert_eq!(sample.upcoming_days.unwrap().get(), 45);
        let body = serde_json::from_str(r#"{"name":"A","upcomingDays":1e999}"#).unwrap();
        assert!(typed_body::<Sample>(&body).is_err());
    }

    #[test]
    fn text_that_is_not_empty_keeps_its_white_space() {
        #[derive(Deserialize)]
        struct Secret {
            password: super::NonEmpty,
        }
        let secret: Secret = typed_body(&json!({"password": " a b "})).unwrap();
        assert_eq!(secret.password.into_string(), " a b ");
        let only_space: Secret = typed_body(&json!({"password": " "})).unwrap();
        assert_eq!(only_space.password.into_string(), " ");
        let Err(error) = typed_body::<Secret>(&json!({"password": ""})) else {
            panic!("an empty password was read");
        };
        assert_eq!(error.message(), "password: must not be empty");
    }

    #[test]
    fn white_space_is_that_of_javascript() {
        let sample: Sample = typed_body(&json!({"name": "\u{feff} Fund "})).unwrap();
        assert_eq!(sample.name.into_string(), "Fund");
        assert_eq!(
            refusal(json!({"name": "\u{feff}"})),
            "name: must not be blank"
        );
        let sample: Sample = typed_body(&json!({"name": "\u{85}"})).unwrap();
        assert_eq!(sample.name.into_string(), "\u{85}");
    }

    #[test]
    fn a_nullable_field_keeps_three_cases_apart() {
        let price = |body: Value| typed_body::<Sample>(&body).unwrap().price;
        assert_eq!(price(json!({"name": "A"})), None);
        assert_eq!(
            price(json!({"name": "A", "price": null})),
            Some(Nullable::Null)
        );
        assert_eq!(
            price(json!({"name": "A", "price": 5}))
                .unwrap()
                .into_option()
                .unwrap()
                .get(),
            5
        );
        let largest: Value =
            serde_json::from_str(r#"{"name":"A","price":9007199254740991}"#).unwrap();
        assert!(typed_body::<Sample>(&largest).is_ok());
        for bad in [
            "0",
            "-1",
            "1.5",
            "\"5\"",
            "9007199254740992",
            "1e999",
            "true",
        ] {
            let body: Value =
                serde_json::from_str(&format!(r#"{{"name":"A","price":{bad}}}"#)).unwrap();
            assert_eq!(refusal(body), "price: must be a positive integer", "{bad}");
        }
    }

    /// The derived schema has the shape that the contract DSL writes: no
    /// `format`, no `null` in the type of a field that can be left out, and
    /// the keyword of each rule.
    #[test]
    fn the_schema_has_the_shape_of_the_contract() {
        assert_eq!(
            serde_json::to_value(schema_of::<Sample>()).unwrap(),
            json!({
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": {"type": "string", "description": "The name.", "minLength": 1},
                    "upcomingDays": {
                        "type": "integer",
                        "description": "The days.",
                        "maximum": 365,
                        "minimum": 1
                    },
                    "price": {
                        "anyOf": [
                            {"type": "integer", "exclusiveMinimum": 0},
                            {"type": "null"}
                        ],
                        "description": "The price."
                    }
                }
            })
        );
    }
}
