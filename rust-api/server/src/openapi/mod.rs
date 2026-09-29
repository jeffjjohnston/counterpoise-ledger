//! `openapi/openapi.json`: the contract a native client builds against.
//!
//! This module is the source of the document. `counterpoise-rust-api openapi`
//! writes it, and `--check` fails when the committed file differs:
//! `npm run openapi:generate` and `npm run openapi:check` run those. See
//! guides/api-contract.md for when a change bumps `API_CONTRACT`.

mod dsl;
mod operations;
mod schemas;

use std::{fs, path::Path};

use utoipa::openapi::{
    ComponentsBuilder, Content, OpenApi, OpenApiBuilder, OpenApiVersion, PathItem, Paths, RefOr,
    Required, Response,
    extensions::Extensions,
    info::InfoBuilder,
    path::{OperationBuilder, Parameter, ParameterBuilder, ParameterIn},
    request_body::RequestBodyBuilder,
    response::ResponseBuilder,
    schema::{KnownFormat, OneOfBuilder, Schema},
    security::{
        ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityRequirement, SecurityScheme,
    },
    server::ServerBuilder,
};

use self::{
    dsl::{Refine, S, integer, reference, string},
    operations::{OPERATIONS, Operation, QueryKind, Security},
};
use crate::routes::system::version_info;

/// The path of the document, from the repository root.
pub(crate) const DOCUMENT_PATH: &str = "openapi/openapi.json";

const JSON: &str = "application/json";

fn json_content(schema: S) -> Content {
    Content::new(Some(schema))
}

fn error_response(description: &str) -> Response {
    ResponseBuilder::new()
        .description(description)
        .content(JSON, json_content(reference("ApiError")))
        .build()
}

fn security(security: Security) -> Vec<SecurityRequirement> {
    let scheme = |name: &str| SecurityRequirement::new::<_, _, String>(name, []);
    match security {
        Security::None => vec![],
        Security::Cookie => vec![scheme("cookieAuth")],
        Security::BearerOrCookie => vec![scheme("bearerAuth"), scheme("cookieAuth")],
    }
}

fn query_schema(kind: QueryKind) -> S {
    match kind {
        QueryKind::String => string(),
        QueryKind::Integer => integer(),
        QueryKind::Boolean => dsl::string_enum(&["true", "false"]),
        QueryKind::DateTime => string().format(KnownFormat::DateTime),
    }
}

fn required(value: bool) -> Required {
    if value {
        Required::True
    } else {
        Required::False
    }
}

fn operation(op: &Operation) -> utoipa::openapi::path::Operation {
    let mut builder = OperationBuilder::new()
        .operation_id(Some(op.operation_id))
        .summary(Some(op.summary))
        .tag(op.tag)
        .securities(Some(security(op.security)))
        // An operation with no parameters writes an empty list.
        .parameters(Some(Vec::<Parameter>::new()));
    let placeholders = op
        .path
        .split('/')
        .filter_map(|segment| segment.strip_prefix('{')?.strip_suffix('}'));
    for name in placeholders {
        builder = builder.parameter(
            ParameterBuilder::new()
                .name(name)
                .parameter_in(ParameterIn::Path)
                .required(Required::True)
                .schema(Some(integer())),
        );
    }
    for query in op.query {
        builder = builder.parameter(
            ParameterBuilder::new()
                .name(query.name)
                .parameter_in(ParameterIn::Query)
                .required(required(query.required))
                .description(Some(query.description))
                .schema(Some(query_schema(query.kind))),
        );
    }
    if let Some(body) = op.body {
        builder = builder.request_body(Some(
            RequestBodyBuilder::new()
                .required(Some(Required::True))
                .content(JSON, json_content(reference(body)))
                .build(),
        ));
    }
    let ok = match op.response {
        [one] => reference(one),
        many => {
            let mut one_of = OneOfBuilder::new();
            for name in many {
                one_of = one_of.item(reference(name));
            }
            RefOr::T(Schema::OneOf(one_of.build()))
        }
    };
    builder = builder.response(
        "200",
        ResponseBuilder::new()
            .description("OK")
            .content(JSON, json_content(ok))
            .build(),
    );
    for (status, description) in op.errors {
        builder = builder.response(status.to_string(), error_response(description));
    }
    builder
        .response(
            "default",
            error_response("Error. The body carries a message."),
        )
        .build()
}

/// The whole document.
pub(crate) fn document() -> OpenApi {
    let (version, contract) = version_info();
    let mut paths = Paths::new();
    for op in OPERATIONS {
        let item = PathItem::new(op.method.clone(), operation(op));
        match paths.paths.get_mut(op.path) {
            Some(existing) => existing.merge_operations(item),
            None => {
                paths.paths.insert(op.path.to_owned(), item);
            }
        }
    }
    let mut components = ComponentsBuilder::new();
    for (name, schema) in schemas::components() {
        components = components.schema(name, schema);
    }
    let components = components
        .security_scheme(
            "bearerAuth",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some("An API key: Authorization: Bearer cpk_..."))
                    .build(),
            ),
        )
        .security_scheme(
            "cookieAuth",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new("counterpoise_session"))),
        )
        .build();
    let info = InfoBuilder::new()
        .title("Counterpoise API")
        .version(version)
        .description(Some(
            "The routes a native client uses. Money is integer cents. Shares and prices are integer micros. Dates are YYYY-MM-DD strings.",
        ))
        .extensions(Some(Extensions::from_iter([(
            "x-api-contract",
            serde_json::json!(contract),
        )])))
        .build();
    let mut document = OpenApiBuilder::new()
        .info(info)
        .servers(Some([ServerBuilder::new()
            .url("/")
            .description(Some("The server this document was fetched from."))
            .build()]))
        .paths(paths)
        .components(Some(components))
        .build();
    document.openapi = OpenApiVersion::Version31;
    document
}

/// The document as the committed file holds it: pretty JSON with a final
/// newline.
pub(crate) fn render() -> String {
    serde_json::to_string_pretty(&document()).expect("the document serializes") + "\n"
}

/// `counterpoise-rust-api openapi [--check] [--out <path>]`. Writes the
/// document, or with `--check` exits 1 when the file is missing or stale.
pub(crate) fn command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let check = args.iter().any(|arg| arg == "--check");
    let out = args
        .iter()
        .position(|arg| arg == "--out")
        .and_then(|index| args.get(index + 1))
        .map_or(DOCUMENT_PATH, String::as_str);
    let fresh = render();
    if check {
        match fs::read_to_string(out) {
            Ok(current) if current == fresh => {
                println!("{out} is current.");
                Ok(())
            }
            Ok(_) => Err(format!(
                "{out} is stale. Run: npm run openapi:generate and commit the result."
            )
            .into()),
            Err(_) => Err(format!("{out} is missing. Run: npm run openapi:generate").into()),
        }
    } else {
        if let Some(parent) = Path::new(out).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(out, fresh)?;
        println!("Wrote {out}");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use utoipa::openapi::HttpMethod;

    #[test]
    fn every_reference_names_a_component() {
        let text = render();
        let names: Vec<&str> = schemas::components()
            .iter()
            .map(|(name, _)| *name)
            .collect();
        for reference in text.split("\"#/components/schemas/").skip(1) {
            let name = reference.split('"').next().unwrap_or_default();
            assert!(names.contains(&name), "{name} is not a component");
        }
    }

    #[test]
    fn component_names_are_unique() {
        let mut names: Vec<&str> = schemas::components()
            .iter()
            .map(|(name, _)| *name)
            .collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn operation_ids_are_unique() {
        let mut ids: Vec<&str> = OPERATIONS.iter().map(|op| op.operation_id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn every_operation_is_a_rust_route() {
        #[derive(serde::Deserialize)]
        struct Route {
            method: String,
            path: String,
        }
        let routes: Vec<Route> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../routes.json"
        )))
        .expect("valid route manifest");
        for op in OPERATIONS {
            let method = match op.method {
                HttpMethod::Get => "GET",
                HttpMethod::Post => "POST",
                HttpMethod::Put => "PUT",
                HttpMethod::Delete => "DELETE",
                HttpMethod::Patch => "PATCH",
                _ => panic!("{} uses a method the contract does not", op.operation_id),
            };
            let path = op.path.replace('{', "[").replace('}', "]");
            assert!(
                routes
                    .iter()
                    .any(|route| route.method == method && route.path == path),
                "{method} {path} is not in rust-api/routes.json"
            );
        }
    }

    #[test]
    fn the_document_carries_the_version_and_the_contract() {
        let document: serde_json::Value =
            serde_json::from_str(&render()).expect("the document is JSON");
        let (version, contract) = version_info();
        assert_eq!(document["openapi"], "3.1.0");
        assert_eq!(document["info"]["version"], version.as_str());
        assert_eq!(document["info"]["x-api-contract"], contract);
    }

    #[test]
    fn the_command_writes_and_checks_the_file() {
        let directory = std::env::temp_dir().join(format!("openapi-{}", std::process::id()));
        let out = directory.join("nested/openapi.json");
        let out_arg = out.to_string_lossy().into_owned();
        let args = |extra: &[&str]| {
            let mut args = vec!["--out".to_owned(), out_arg.clone()];
            args.extend(extra.iter().map(|arg| (*arg).to_owned()));
            args
        };
        let missing = command(&args(&["--check"])).expect_err("a missing file fails");
        assert!(missing.to_string().contains("openapi:generate"));
        command(&args(&[])).expect("the file is written");
        assert_eq!(fs::read_to_string(&out).expect("written"), render());
        command(&args(&["--check"])).expect("a current file passes");
        fs::write(&out, "{}\n").expect("the file is replaced");
        let stale = command(&args(&["--check"])).expect_err("a stale file fails");
        assert!(stale.to_string().contains("openapi:generate"));
        fs::remove_dir_all(directory).expect("the directory is removed");
    }

    #[test]
    fn the_committed_document_is_current() {
        let committed = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../openapi/openapi.json"
        ));
        assert!(
            committed == render(),
            "openapi/openapi.json is stale. Run: npm run openapi:generate"
        );
    }
}
