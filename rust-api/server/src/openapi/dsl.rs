//! A small vocabulary over utoipa's schema model, so that each component
//! schema reads close to the JSON Schema it writes.
//!
//! A schema here is written with the exact JSON Schema shape of the contract.
//! The utoipa derive macros write other shapes: `format: int64` on an
//! integer, `oneOf` for a nullable field, and an optional field for each
//! `Option`. A native client's generated types follow the shape, so the
//! document keeps it.

use serde_json::Value;
use utoipa::{
    Number,
    openapi::{
        RefOr,
        extensions::Extensions,
        schema::{
            AnyOfBuilder, ArrayBuilder, KnownFormat, ObjectBuilder, Ref, Schema, SchemaFormat,
            SchemaType, Type,
        },
    },
};

pub(super) type S = RefOr<Schema>;

fn of_type(schema_type: SchemaType) -> S {
    ObjectBuilder::new().schema_type(schema_type).into()
}

pub(super) fn integer() -> S {
    of_type(SchemaType::Type(Type::Integer))
}

pub(super) fn string() -> S {
    of_type(SchemaType::Type(Type::String))
}

pub(super) fn boolean() -> S {
    of_type(SchemaType::Type(Type::Boolean))
}

pub(super) fn null() -> S {
    of_type(SchemaType::Type(Type::Null))
}

/// A type list, such as `["string", "null"]`.
pub(super) fn types(types: &[Type]) -> S {
    of_type(SchemaType::Array(types.to_vec()))
}

/// `{ "$ref": "#/components/schemas/<name>" }`.
pub(super) fn reference(name: &str) -> S {
    RefOr::Ref(Ref::from_schema_name(name))
}

pub(super) fn any_of(items: Vec<S>) -> S {
    let mut builder = AnyOfBuilder::new();
    for item in items {
        builder = builder.item(item);
    }
    Schema::AnyOf(builder.build()).into()
}

/// `anyOf` the schema and `null`.
pub(super) fn nullable(schema: S) -> S {
    any_of(vec![schema, null()])
}

pub(super) fn array(items: S) -> S {
    Schema::Array(ArrayBuilder::new().items(items).build()).into()
}

pub(super) fn string_enum(values: &[&str]) -> S {
    ObjectBuilder::new()
        .schema_type(SchemaType::Type(Type::String))
        .enum_values(Some(values.iter().copied()))
        .into()
}

/// An object. Each property is `(name, schema, required)`, in document order.
pub(super) fn object(properties: Vec<(&str, S, bool)>) -> S {
    let mut builder = ObjectBuilder::new().schema_type(SchemaType::Type(Type::Object));
    for (name, schema, required) in properties {
        builder = builder.property(name, schema);
        if required {
            builder = builder.required(name);
        }
    }
    builder.into()
}

/// The keywords that refine a schema.
pub(super) trait Refine: Sized {
    fn describe(self, text: &str) -> Self;
    fn format(self, format: KnownFormat) -> Self;
    fn exclusive_minimum(self, value: i64) -> Self;
    fn minimum(self, value: i64) -> Self;
    fn maximum(self, value: i64) -> Self;
    fn min_length(self, value: usize) -> Self;
    fn min_items(self, value: usize) -> Self;
    fn constant(self, value: Value) -> Self;
}

fn object_mut<'a>(schema: &'a mut S, keyword: &str) -> &'a mut utoipa::openapi::schema::Object {
    match schema {
        RefOr::T(Schema::Object(object)) => object,
        _ => panic!("{keyword} applies to a typed schema only"),
    }
}

fn number(value: i64) -> Number {
    Number::Int(isize::try_from(value).expect("a schema bound fits in isize"))
}

impl Refine for S {
    fn describe(mut self, text: &str) -> Self {
        let text = text.to_owned();
        match &mut self {
            RefOr::Ref(reference) => reference.description = text,
            RefOr::T(Schema::Object(object)) => object.description = Some(text),
            RefOr::T(Schema::AnyOf(any_of)) => any_of.description = Some(text),
            RefOr::T(Schema::Array(array)) => array.description = Some(text),
            RefOr::T(_) => panic!("describe does not apply to this schema"),
        }
        self
    }

    fn format(mut self, format: KnownFormat) -> Self {
        object_mut(&mut self, "format").format = Some(SchemaFormat::KnownFormat(format));
        self
    }

    fn exclusive_minimum(mut self, value: i64) -> Self {
        object_mut(&mut self, "exclusiveMinimum").exclusive_minimum = Some(number(value));
        self
    }

    fn minimum(mut self, value: i64) -> Self {
        object_mut(&mut self, "minimum").minimum = Some(number(value));
        self
    }

    fn maximum(mut self, value: i64) -> Self {
        object_mut(&mut self, "maximum").maximum = Some(number(value));
        self
    }

    fn min_length(mut self, value: usize) -> Self {
        object_mut(&mut self, "minLength").min_length = Some(value);
        self
    }

    fn min_items(mut self, value: usize) -> Self {
        match &mut self {
            RefOr::T(Schema::Array(array)) => array.min_items = Some(value),
            _ => panic!("minItems applies to an array only"),
        }
        self
    }

    /// `const`, which utoipa's schema object has no field for: it goes in
    /// the extensions, which serialize flat into the object.
    fn constant(mut self, value: Value) -> Self {
        let object = object_mut(&mut self, "const");
        let mut extensions = object.extensions.take().unwrap_or_default();
        extensions.merge(Extensions::from_iter([("const", value)]));
        object.extensions = Some(extensions);
        self
    }
}
