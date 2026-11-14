//! Converts the Markdown of a transaction note to HTML for the register's note
//! popup.
//!
//! The browser puts the result into the page as HTML, so this function must
//! not let a note add markup or a script:
//! - It drops raw HTML (block and inline). It does not escape it as text.
//! - A link or an image is kept only when its target is `http:`, `https:` or
//!   `mailto:`. For other targets (`javascript:`, `data:`, relative paths),
//!   only the text of the link or the alt text of the image stays.
//! - pulldown-cmark escapes all text and attribute values.
//!
//! The GFM extensions that notes use are on: tables, strikethrough, task lists
//! and autolinks. pulldown-cmark has no bare-URL autolinks, so `autolink`
//! below supplies them (`https://…`, `http://…` and `www.…`).

use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd, TextMergeStream};

/// The HTML for the Markdown note `markdown`. See the module comment for the
/// rules that make the result safe to put into the page.
pub fn note_html(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM;
    // Merge the adjacent text events: the parser can split a URL into more
    // than one event, and `autolink` must see it whole.
    let events = TextMergeStream::new(Parser::new_ext(markdown, options));

    let mut out = Vec::new();
    // Depth of link and image tags that we kept, and of code blocks. Text in
    // these gets no autolinks.
    let mut no_autolink_depth = 0usize;
    // For each open link or image: true when we dropped its tag. The matching
    // end tag must then also go.
    let mut dropped: Vec<bool> = Vec::new();

    for event in events {
        match event {
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let keep = allowed_target(&dest_url, link_type);
                dropped.push(!keep);
                if keep {
                    no_autolink_depth += 1;
                    out.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let keep = allowed_target(&dest_url, link_type) && !is_mailto(&dest_url);
                dropped.push(!keep);
                if keep {
                    no_autolink_depth += 1;
                    out.push(Event::Start(Tag::Image {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                }
            }
            Event::End(end @ (TagEnd::Link | TagEnd::Image)) => {
                if !dropped.pop().unwrap_or(false) {
                    no_autolink_depth = no_autolink_depth.saturating_sub(1);
                    out.push(Event::End(end));
                }
            }
            Event::Start(tag @ Tag::CodeBlock(_)) => {
                no_autolink_depth += 1;
                out.push(Event::Start(tag));
            }
            Event::End(TagEnd::CodeBlock) => {
                no_autolink_depth = no_autolink_depth.saturating_sub(1);
                out.push(Event::End(TagEnd::CodeBlock));
            }
            Event::Text(text) if no_autolink_depth == 0 => autolink(text, &mut out),
            other => out.push(other),
        }
    }

    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, out.into_iter());
    html
}

fn is_mailto(url: &str) -> bool {
    url.get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
}

/// True when a link or image may point to `url`. An email autolink
/// (`<name@example.com>`) has no scheme in `url`; the HTML writer adds
/// `mailto:`.
fn allowed_target(url: &str, link_type: LinkType) -> bool {
    if link_type == LinkType::Email {
        return true;
    }
    ["http://", "https://", "mailto:"].iter().any(|scheme| {
        url.get(..scheme.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
    })
}

/// Pushes `text` to `out`, with each bare URL in it as a link.
fn autolink<'a>(text: CowStr<'a>, out: &mut Vec<Event<'a>>) {
    let mut pieces: Vec<Event<'a>> = Vec::new();
    // The byte offset in `text` that the pieces go up to.
    let mut done = 0;

    while let Some((start, end)) = next_url(&text, done) {
        if start > done {
            pieces.push(Event::Text(CowStr::from(text[done..start].to_owned())));
        }
        let url = &text[start..end];
        let href = if url.get(..4).is_some_and(|w| w.eq_ignore_ascii_case("www.")) {
            format!("http://{url}")
        } else {
            url.to_owned()
        };
        pieces.push(Event::Start(Tag::Link {
            link_type: LinkType::Autolink,
            dest_url: CowStr::from(href),
            title: CowStr::Borrowed(""),
            id: CowStr::Borrowed(""),
        }));
        pieces.push(Event::Text(CowStr::from(url.to_owned())));
        pieces.push(Event::End(TagEnd::Link));
        done = end;
    }

    if pieces.is_empty() {
        out.push(Event::Text(text));
        return;
    }
    if done < text.len() {
        pieces.push(Event::Text(CowStr::from(text[done..].to_owned())));
    }
    out.extend(pieces);
}

/// The prefixes that start a bare URL. No prefix starts with another one.
const URL_PREFIXES: [&str; 3] = ["https://", "http://", "www."];

/// The byte range of the first bare URL in `text` at or after the offset
/// `from`, as GFM finds it. A URL starts with `http://`, `https://` or
/// `www.`, after the start of the text, a space, or one of `*`, `_`, `~` and
/// `(`. It ends before a space or `<`, and without trailing punctuation or an
/// unmatched `)`.
///
/// The scan is linear in the length of `text`, also across the calls that
/// `autolink` makes. The prefix search reads each byte once. The search for
/// the end runs only for a candidate after a boundary. Such a candidate is
/// the last one in its run of characters with no space: if it is a URL, only
/// punctuation comes after its end, and if it is not, the run has no letter
/// or digit after it.
fn next_url(text: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut search = from;
    while search < bytes.len() {
        let (start, prefix_len) = (search..bytes.len()).find_map(|at| {
            URL_PREFIXES
                .iter()
                .find(|prefix| {
                    bytes[at..]
                        .get(..prefix.len())
                        .is_some_and(|found| found.eq_ignore_ascii_case(prefix.as_bytes()))
                })
                .map(|prefix| (at, prefix.len()))
        })?;
        search = start + prefix_len;
        let prior = text[..start].chars().next_back();
        if prior.is_some_and(|c| !c.is_whitespace() && !"*_~(".contains(c)) {
            continue;
        }
        let run_end = start
            + text[start..]
                .find(|c: char| c.is_whitespace() || c == '<')
                .unwrap_or(text.len() - start);
        let end = trim_url_end(text, start, run_end);
        // A URL needs a domain after the prefix. The trim can also remove
        // the last character of the prefix (the dot of `www.`), so make sure
        // that the end is after the prefix before the slice.
        if end > start + prefix_len
            && text[start + prefix_len..end].contains(|c: char| c.is_alphanumeric())
        {
            return Some((start, end));
        }
        // The run has no letter or digit after the prefix, thus it has no
        // other candidate.
        search = run_end;
    }
    None
}

/// The end of the URL `text[start..end]` without its trailing punctuation and
/// without a final `)` that has no `(` to match it. It counts the
/// parentheses one time, and then adjusts the count for each `)` it removes.
fn trim_url_end(text: &str, start: usize, mut end: usize) -> usize {
    let url = &text[start..end];
    let opens = url.matches('(').count();
    let mut closes = url.matches(')').count();
    while let Some(last) = text[start..end].chars().next_back() {
        if last == ')' && closes > opens {
            closes -= 1;
        } else if !"?!.,:*_~'\"".contains(last) {
            break;
        }
        end -= last.len_utf8();
    }
    end
}

#[cfg(test)]
mod tests {
    use super::note_html;

    #[test]
    fn renders_plain_markdown() {
        assert_eq!(
            note_html("Paid **twice**, see _receipt_."),
            "<p>Paid <strong>twice</strong>, see <em>receipt</em>.</p>\n"
        );
    }

    #[test]
    fn drops_raw_html_blocks_and_inline_html() {
        let html = note_html("<script>alert(1)</script>\n\nok <b onclick=\"x()\">bold</b>");
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("<b"), "{html}");
        assert!(!html.contains("onclick"), "{html}");
        assert!(html.contains("ok bold"), "{html}");
    }

    #[test]
    fn drops_an_image_tag_written_as_html() {
        let html = note_html("<img src=x onerror=alert(1)>");
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
    }

    #[test]
    fn keeps_only_the_text_of_a_javascript_link() {
        for note in [
            "[click](javascript:alert(1))",
            "[click](JavaScript:alert(1))",
            "[click](  javascript:alert(1) )",
            "[click](data:text/html,<script>alert(1)</script>)",
            "[click](/b/1/accounts)",
            "[click](vbscript:msgbox)",
        ] {
            let html = note_html(note);
            assert!(!html.contains("<a"), "{note}: {html}");
            assert!(
                !html.to_ascii_lowercase().contains("script:"),
                "{note}: {html}"
            );
            assert!(html.contains("click"), "{note}: {html}");
        }
    }

    #[test]
    fn drops_a_javascript_autolink() {
        let html = note_html("<javascript:alert(1)>");
        assert!(!html.contains("<a"), "{html}");
    }

    #[test]
    fn keeps_http_https_and_mailto_links() {
        assert_eq!(
            note_html(
                "[a](https://example.com/x?y=1&z=2) [b](http://example.com) [c](mailto:me@example.com)"
            ),
            "<p><a href=\"https://example.com/x?y=1&amp;z=2\">a</a> \
             <a href=\"http://example.com\">b</a> \
             <a href=\"mailto:me@example.com\">c</a></p>\n"
        );
    }

    #[test]
    fn keeps_an_email_autolink() {
        assert_eq!(
            note_html("<me@example.com>"),
            "<p><a href=\"mailto:me@example.com\">me@example.com</a></p>\n"
        );
    }

    #[test]
    fn escapes_quotes_in_a_link_target() {
        let html = note_html("[a](https://example.com/\"onmouseover=\"x())");
        assert!(!html.contains("\"onmouseover"), "{html}");
    }

    #[test]
    fn keeps_an_https_image_and_drops_others() {
        assert_eq!(
            note_html("![receipt](https://example.com/r.png)"),
            "<p><img src=\"https://example.com/r.png\" alt=\"receipt\" /></p>\n"
        );
        assert_eq!(note_html("![receipt](receipt.png)"), "<p>receipt</p>\n");
        assert_eq!(note_html("![receipt](javascript:x)"), "<p>receipt</p>\n");
        assert_eq!(
            note_html("![receipt](mailto:me@example.com)"),
            "<p>receipt</p>\n"
        );
    }

    #[test]
    fn renders_a_table() {
        let html = note_html("| Item | Cost |\n| --- | ---: |\n| Lamp | $20 |");
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("<th>Item</th>"), "{html}");
        assert!(
            html.contains("<td style=\"text-align: right\">$20</td>"),
            "{html}"
        );
    }

    #[test]
    fn renders_strikethrough() {
        assert_eq!(note_html("~~old~~ new"), "<p><del>old</del> new</p>\n");
    }

    #[test]
    fn renders_a_task_list() {
        let html = note_html("- [x] filed\n- [ ] paid");
        assert!(
            html.contains("<input disabled=\"\" type=\"checkbox\" checked=\"\"/>"),
            "{html}"
        );
        assert!(
            html.contains("<input disabled=\"\" type=\"checkbox\"/>\npaid"),
            "{html}"
        );
    }

    #[test]
    fn links_bare_urls() {
        assert_eq!(
            note_html(
                "See https://example.com/a_b?c=1&d=2. Or www.example.org, then (http://x.io/p)."
            ),
            "<p>See <a href=\"https://example.com/a_b?c=1&amp;d=2\">https://example.com/a_b?c=1&amp;d=2</a>. \
             Or <a href=\"http://www.example.org\">www.example.org</a>, \
             then (<a href=\"http://x.io/p\">http://x.io/p</a>).</p>\n"
        );
    }

    #[test]
    fn keeps_a_matched_paren_in_a_bare_url() {
        assert_eq!(
            note_html("https://en.wikipedia.org/wiki/Foo_(bar)"),
            "<p><a href=\"https://en.wikipedia.org/wiki/Foo_(bar)\">https://en.wikipedia.org/wiki/Foo_(bar)</a></p>\n"
        );
    }

    #[test]
    fn does_not_link_a_url_inside_a_word_code_or_a_link() {
        assert_eq!(
            note_html("xhttps://example.com"),
            "<p>xhttps://example.com</p>\n"
        );
        assert_eq!(
            note_html("`https://example.com`"),
            "<p><code>https://example.com</code></p>\n"
        );
        assert_eq!(
            note_html("```\nhttps://example.com\n```"),
            "<pre><code>https://example.com\n</code></pre>\n"
        );
        assert_eq!(
            note_html("[https://a.com](https://b.com)"),
            "<p><a href=\"https://b.com\">https://a.com</a></p>\n"
        );
        assert_eq!(note_html("https:// alone"), "<p>https:// alone</p>\n");
    }

    #[test]
    fn does_not_fail_on_a_prefix_with_no_domain() {
        for note in ["www.", "See www...", "http://.", "https://?", "(www.)"] {
            let html = note_html(note);
            assert!(!html.contains("<a"), "{note}: {html}");
        }
    }

    /// Many short notes made of URL parts and punctuation. `note_html` must
    /// not fail on any of them: a failure in the browser stops the render.
    #[test]
    fn does_not_fail_on_url_fragments() {
        const PARTS: [&str; 16] = [
            "www.", "http://", "https://", ".", ")", "(", "é", " ", "<", "_", "a", "*", "~", "?",
            "[x](", "`",
        ];
        let mut state: u32 = 42;
        for _ in 0..50_000 {
            let mut note = String::new();
            for _ in 0..6 {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                note.push_str(PARTS[(state >> 16) as usize % PARTS.len()]);
            }
            note_html(&note);
        }
    }

    /// Notes of 100 KB that made the URL scan quadratic. The scan must stay
    /// linear: a slow render freezes the hover popup in the browser. A linear
    /// scan takes milliseconds, so the bound is safe on a slow machine.
    #[test]
    fn scans_a_long_note_in_linear_time() {
        let notes = [
            // Many candidates that no boundary comes before.
            format!("x{}", "www.".repeat(25_000)),
            // Many candidates, and no `https://` or `http://` to find.
            "(www.) ".repeat(14_000),
            // One URL with a long run of `)` to trim.
            format!("http://a.io/{}", ")".repeat(100_000)),
            // The same, with punctuation between the parentheses.
            format!("http://a.io/{}", ").".repeat(50_000)),
            // Many URLs in one text.
            "http://a.io ".repeat(8_000),
        ];
        for note in &notes {
            let started = std::time::Instant::now();
            let html = note_html(note);
            let elapsed = started.elapsed();
            assert!(!html.is_empty());
            assert!(
                elapsed < std::time::Duration::from_secs(5),
                "{} bytes starting {:?} took {elapsed:?}",
                note.len(),
                &note[..16]
            );
        }
    }

    #[test]
    fn links_more_than_one_bare_url() {
        assert_eq!(
            note_html("https://a.com https://b.com"),
            "<p><a href=\"https://a.com\">https://a.com</a> <a href=\"https://b.com\">https://b.com</a></p>\n"
        );
    }

    #[test]
    fn handles_non_ascii_text_around_a_url() {
        assert_eq!(
            note_html("café https://example.com/é ✓"),
            "<p>café <a href=\"https://example.com/%C3%A9\">https://example.com/é</a> ✓</p>\n"
        );
    }
}
