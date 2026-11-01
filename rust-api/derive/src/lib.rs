//! `#[derive(FromRow)]` for `ledger_db::store`: a struct decodes from a row
//! by column name, as sqlx's derive of the same name did. A field reads the
//! column of its own name (`r#type` reads `type`), or the name in
//! `#[row(rename = "...")]`.

use proc_macro::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Fields, LitStr, parse_macro_input};

#[proc_macro_derive(FromRow, attributes(row))]
pub fn derive_from_row(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn expand(input: &DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new_spanned(
            input,
            "FromRow derives only for a struct",
        ));
    };
    let Fields::Named(fields) = &data.fields else {
        return Err(syn::Error::new_spanned(
            input,
            "FromRow needs a struct with named fields",
        ));
    };
    let mut reads = Vec::new();
    for field in &fields.named {
        let ident = field.ident.as_ref().expect("a named field");
        let mut column = ident.to_string().trim_start_matches("r#").to_owned();
        for attribute in field.attrs.iter().filter(|a| a.path().is_ident("row")) {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("rename") {
                    column = meta.value()?.parse::<LitStr>()?.value();
                    Ok(())
                } else {
                    Err(meta.error("expected `rename = \"column\"`"))
                }
            })?;
        }
        reads.push(quote! { #ident: row.column(#column)? });
    }
    let name = &input.ident;
    let (impl_generics, type_generics, where_clause) = input.generics.split_for_impl();
    Ok(quote! {
        impl #impl_generics ::ledger_db::store::FromRow for #name #type_generics #where_clause {
            fn from_row(
                row: &::ledger_db::store::Row,
            ) -> ::std::result::Result<Self, ::ledger_db::store::Error> {
                ::std::result::Result::Ok(Self { #(#reads,)* })
            }
        }
    })
}
