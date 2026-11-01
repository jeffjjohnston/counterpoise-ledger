//! The text of the GitHub issue for one issue report. No I/O.
//!
//! The report text comes from app users. The description goes in a fenced
//! code block and the page in a code span, so that `@name` does not notify a
//! GitHub user and `#12` does not link an issue. No report ID has a `#`
//! before it, for the same reason.
//!
//! The route sets no length limit on the description or the page, and GitHub
//! refuses a body over 65,536 characters. Thus the body holds at most 60,000
//! characters of the description and 500 of the page, and the full body is at
//! most 65,000 characters. A long backtick run makes a long fence, so the job
//! can cut the description to fewer than 60,000 characters.

/// The label of each issue that the job opens. The workflow and the recover
/// step select issues by it.
pub(crate) const LABEL: &str = "from-app";

const MARKER_START: &str = "<!-- counterpoise-report:";
const MARKER_END: &str = " -->";
const TITLE_PAGE_CHARS: usize = 80;
const BODY_PAGE_CHARS: usize = 500;
/// GitHub refuses an issue body over 65,536 characters. This cap leaves room
/// for the fields, the fence and the marker.
const DESCRIPTION_CHARS: usize = 60_000;
/// The limit for the full body: the fields, the two fences, the description,
/// the cut note and the marker.
const BODY_CHARS: usize = 65_000;
const DESCRIPTION_CUT_NOTE: &str =
    "The issue shows only the start of the description. Read the full text in the app.";

pub(crate) struct Report<'a> {
    pub(crate) id: i32,
    pub(crate) kind: &'a str,
    pub(crate) page: &'a str,
    pub(crate) description: &'a str,
    /// The UTC time of the report, RFC 3339.
    pub(crate) filed: &'a str,
}

/// The title is one line: each control character and line break in the page
/// becomes a space before the cut.
pub(crate) fn title(report: &Report<'_>) -> String {
    let flat: String = report
        .page
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let (page, cut) = cut_chars(&flat, TITLE_PAGE_CHARS);
    let cut = if cut { "…" } else { "" };
    format!("App report {} ({}) on {page}{cut}", report.id, report.kind)
}

/// The body with as much of the description as fits. The fence is one longer
/// than the longest backtick run in the posted text, so the size of the body
/// goes up when the description gets longer. A binary search thus finds the
/// longest cut that fits in `BODY_CHARS`.
pub(crate) fn body(report: &Report<'_>) -> String {
    let full = render(report, DESCRIPTION_CHARS);
    if fits(&full) {
        return full;
    }
    // render(low) fits and render(high) does not. With an empty description
    // the body holds only the fields, the page (500 characters at most) and
    // the marker, so it fits.
    let mut low = 0;
    let mut high = DESCRIPTION_CHARS.min(report.description.chars().count());
    while high - low > 1 {
        let mid = low + (high - low) / 2;
        if fits(&render(report, mid)) {
            low = mid;
        } else {
            high = mid;
        }
    }
    render(report, low)
}

fn fits(text: &str) -> bool {
    text.chars().count() <= BODY_CHARS
}

/// The body with the first `max` characters of the description.
fn render(report: &Report<'_>, max: usize) -> String {
    let (description, cut) = cut_chars(report.description, max);
    let note = if cut {
        format!("{DESCRIPTION_CUT_NOTE}\n\n")
    } else {
        String::new()
    };
    let (page, page_cut) = cut_chars(report.page, BODY_PAGE_CHARS);
    let page = if page_cut {
        format!("{page}…")
    } else {
        page.to_owned()
    };
    // The fence is computed on the text that is posted, not on the full text.
    let fence = "`".repeat(longest_backtick_run(description).max(2) + 1);
    format!(
        "**Report:** {id}\n\
         **Type:** {kind}\n\
         **Page:** {page}\n\
         **Filed:** {filed}\n\
         \n\
         **Description:**\n\
         \n\
         {fence}text\n\
         {description}\n\
         {fence}\n\
         \n\
         {note}\
         {MARKER_START}{id}{MARKER_END}\n",
        id = report.id,
        kind = report.kind,
        page = code_span(&page),
        filed = report.filed,
    )
}

/// The first `max` characters of `text`, cut on a character boundary, and
/// whether the text was longer.
fn cut_chars(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((end, _)) => (&text[..end], true),
        None => (text, false),
    }
}

/// The report ID in the marker on the last line of `body`. A marker on any
/// other line is not read: a description can hold the marker text.
pub(crate) fn marker_id(body: &str) -> Option<i32> {
    body.trim_end()
        .lines()
        .last()?
        .strip_prefix(MARKER_START)?
        .strip_suffix(MARKER_END)?
        .parse::<u32>()
        .ok()
        .and_then(|id| i32::try_from(id).ok())
}

fn longest_backtick_run(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

/// `text` as one inline code span. Line breaks become spaces. The delimiter
/// is longer than the longest backtick run in the text. Spaces pad the text
/// when it starts or ends with a backtick.
fn code_span(text: &str) -> String {
    let flat = text.replace(['\r', '\n'], " ");
    let delimiter = "`".repeat(longest_backtick_run(&flat) + 1);
    if flat.starts_with('`') || flat.ends_with('`') {
        format!("{delimiter} {flat} {delimiter}")
    } else {
        format!("{delimiter}{flat}{delimiter}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report<'a>(description: &'a str, page: &'a str) -> Report<'a> {
        Report {
            id: 17,
            kind: "bug",
            page,
            description,
            filed: "2026-10-14T09:00:00Z",
        }
    }

    #[test]
    fn the_title_names_the_report_without_a_hash() {
        assert_eq!(
            title(&report("x", "/b/1/accounts")),
            "App report 17 (bug) on /b/1/accounts"
        );
    }

    #[test]
    fn the_title_cuts_a_long_page_at_80_characters() {
        let page = "é".repeat(100);
        let text = title(&report("x", &page));
        assert_eq!(text, format!("App report 17 (bug) on {}…", "é".repeat(80)));
    }

    #[test]
    fn the_body_has_the_fields_the_fence_and_the_marker_last() {
        let text = body(&report("It broke.", "/b/1/accounts"));
        assert_eq!(
            text,
            "**Report:** 17\n\
             **Type:** bug\n\
             **Page:** `/b/1/accounts`\n\
             **Filed:** 2026-10-14T09:00:00Z\n\
             \n\
             **Description:**\n\
             \n\
             ```text\n\
             It broke.\n\
             ```\n\
             \n\
             <!-- counterpoise-report:17 -->\n"
        );
        assert_eq!(marker_id(&text), Some(17));
    }

    #[test]
    fn a_backtick_run_in_the_description_gets_a_longer_fence() {
        let text = body(&report("a ```` b", "/p"));
        assert!(text.contains("\n`````text\na ```` b\n`````\n"), "{text}");
    }

    #[test]
    fn mentions_and_references_stay_inside_the_fence() {
        let text = body(&report("ping @octocat about #12", "/p"));
        let fenced = text.split("```text\n").nth(1).unwrap();
        assert!(fenced.starts_with("ping @octocat about #12\n```"));
        assert!(!text.split("```text").next().unwrap().contains('@'));
    }

    #[test]
    fn a_page_with_a_mention_or_backticks_stays_in_a_code_span() {
        let text = body(&report("x", "/p?q=@octocat`x``"));
        assert!(
            text.contains("**Page:** ``` /p?q=@octocat`x`` ```\n"),
            "{text}"
        );
    }

    #[test]
    fn a_page_with_a_line_break_stays_on_one_line() {
        let text = body(&report("x", "/p\n**Type:** fake"));
        assert!(text.contains("**Page:** `/p **Type:** fake`\n"), "{text}");
        assert_eq!(text.matches("**Type:**").count(), 2);
    }

    #[test]
    fn a_long_description_is_cut_below_the_github_limit() {
        let description = "é".repeat(100_000);
        let text = body(&report(&description, "/p"));
        assert!(text.chars().count() <= 65_000, "{}", text.chars().count());
        assert!(text.contains(&format!("```text\n{}\n```\n", "é".repeat(60_000))));
        assert!(text.contains(
            "\n```\n\nThe issue shows only the start of the description. \
             Read the full text in the app.\n\n<!-- counterpoise-report:17 -->\n"
        ));
        assert_eq!(marker_id(&text), Some(17));
    }

    #[test]
    fn a_description_at_the_limit_is_not_cut() {
        let description = "x".repeat(60_000);
        let text = body(&report(&description, "/p"));
        assert!(text.contains(&format!("```text\n{description}\n```\n")));
        assert!(!text.contains(DESCRIPTION_CUT_NOTE));
    }

    #[test]
    fn the_fence_counts_only_the_posted_text() {
        let description = format!("{}``````", "x".repeat(60_000));
        let text = body(&report(&description, "/p"));
        assert!(text.contains("\n```text\n"), "the fence must stay at 3");
        assert!(!text.contains("````"));
    }

    /// The body is at most 65,000 characters, the marker is the last line,
    /// the posted text cannot close the fence, and the cut note is there.
    fn assert_the_body_fits(text: &str) {
        assert!(text.chars().count() <= 65_000, "{}", text.chars().count());
        assert_eq!(marker_id(text), Some(17));
        assert!(text.contains(&format!(
            "\n\n{DESCRIPTION_CUT_NOTE}\n\n<!-- counterpoise-report:17 -->\n"
        )));
        let start = text.find("**Description:**\n\n").unwrap() + "**Description:**\n\n".len();
        let fence_len = text[start..].find("text\n").unwrap();
        let fence = &text[start..start + fence_len];
        assert!(
            fence.len() >= 3 && fence.bytes().all(|b| b == b'`'),
            "{fence}"
        );
        let posted_start = start + fence_len + "text\n".len();
        let posted_end =
            text[posted_start..].rfind(&format!("\n{fence}\n")).unwrap() + posted_start;
        let posted = &text[posted_start..posted_end];
        assert!(longest_backtick_run(posted) < fence.len());
        assert!(!posted.is_empty());
    }

    #[test]
    fn a_description_of_30000_backticks_fits_with_its_fence() {
        let description = "`".repeat(30_000);
        assert_the_body_fits(&body(&report(&description, "/p")));
    }

    #[test]
    fn a_description_of_60000_backticks_fits_with_its_fence() {
        let description = "`".repeat(60_000);
        assert_the_body_fits(&body(&report(&description, "/p")));
    }

    #[test]
    fn a_long_backtick_run_and_a_long_page_fit_together() {
        let description = format!("{}{}", "x".repeat(40_000), "`".repeat(30_000));
        let page = "`".repeat(2_000);
        assert_the_body_fits(&body(&report(&description, &page)));
    }

    #[test]
    fn a_long_page_is_cut_in_the_body() {
        let page = "p".repeat(2_000);
        let text = body(&report("x", &page));
        assert!(
            text.contains(&format!("**Page:** `{}…`\n", "p".repeat(500))),
            "{text}"
        );
    }

    #[test]
    fn a_page_with_control_characters_gives_a_one_line_title() {
        let text = title(&report("x", "/p\n\tq\r\u{2028}r\u{7}"));
        assert_eq!(text, "App report 17 (bug) on /p  q  r ");
    }

    #[test]
    fn a_marker_inside_the_description_is_not_read() {
        let text = body(&report("<!-- counterpoise-report:1 -->", "/p"));
        assert_eq!(marker_id(&text), Some(17));
        let forged = "text\n<!-- counterpoise-report:1 -->\nmore\n";
        assert_eq!(marker_id(forged), None);
    }

    #[test]
    fn a_body_without_a_marker_has_no_id() {
        assert_eq!(marker_id(""), None);
        assert_eq!(marker_id("<!-- counterpoise-report:x -->"), None);
        assert_eq!(marker_id("<!-- counterpoise-report:-3 -->"), None);
    }
}
