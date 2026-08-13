use napi::Task;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi_derive::napi;
use std::collections::HashMap;
use std::io::Cursor;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, OnceLock, RwLock};
#[cfg(test)]
use syntect::easy::HighlightLines;
use syntect::highlighting::Color;
use syntect::highlighting::FontStyle;
use syntect::highlighting::HighlightIterator;
use syntect::highlighting::HighlightState;
use syntect::highlighting::Highlighter;
use syntect::highlighting::Style;
use syntect::highlighting::Theme;
use syntect::highlighting::ThemeSet;
use syntect::parsing::Scope;
use syntect::parsing::ScopeStack;
use syntect::parsing::ParseState;
use syntect::parsing::SyntaxReference;
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedLazyThemeSet;
use two_face::theme::EmbeddedThemeName;

const MAX_HIGHLIGHT_BYTES: usize = 512 * 1024;
const MAX_HIGHLIGHT_LINES: usize = 10_000;
const MAX_HIGHLIGHT_SPANS: usize = 200_000;
const MAX_CUSTOM_THEME_BYTES: usize = 512 * 1024;
const ANSI_ALPHA_INDEX: u8 = 0x00;
const ANSI_ALPHA_DEFAULT: u8 = 0x01;
const OPAQUE_ALPHA: u8 = 0xFF;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<EmbeddedLazyThemeSet> = OnceLock::new();
static CUSTOM_THEMES: OnceLock<RwLock<HashMap<String, Arc<Theme>>>> = OnceLock::new();

const BUILTIN_THEME_NAMES: &[&str] = &[
    "1337",
    "ansi",
    "base16",
    "base16-256",
    "base16-eighties-dark",
    "base16-mocha-dark",
    "base16-ocean-dark",
    "base16-ocean-light",
    "catppuccin-frappe",
    "catppuccin-latte",
    "catppuccin-macchiato",
    "catppuccin-mocha",
    "coldark-cold",
    "coldark-dark",
    "dark-neon",
    "dracula",
    "github",
    "gruvbox-dark",
    "gruvbox-light",
    "inspired-github",
    "monokai-extended",
    "monokai-extended-bright",
    "monokai-extended-light",
    "monokai-extended-origin",
    "nord",
    "one-half-dark",
    "one-half-light",
    "solarized-dark",
    "solarized-light",
    "sublime-snazzy",
    "two-dark",
    "zenburn",
];

#[napi(object)]
pub struct EngineInfo {
    pub addon: String,
    pub api_version: u32,
    pub engine_build_id: String,
}

#[napi]
pub fn engine_info() -> EngineInfo {
    EngineInfo {
        addon: "runledger-syntax-highlighter".to_string(),
        api_version: 1,
        engine_build_id: concat!(
            "runledger-syntax-highlighter@",
            env!("CARGO_PKG_VERSION"),
            "+syntect-5.3.0+two-face-0.5.1+napi8",
            "+",
            env!("RUNLEDGER_SYNTAX_ENGINE_SOURCE_ID")
        )
        .to_string(),
    }
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HighlightColorDto {
    pub kind: String,
    pub index: Option<u32>,
    pub r: Option<u32>,
    pub g: Option<u32>,
    pub b: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HighlightSpanDto {
    pub text: String,
    pub foreground: HighlightColorDto,
    pub bold: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HighlightLineDto {
    pub spans: Vec<HighlightSpanDto>,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HighlightResultDto {
    pub ok: bool,
    pub lines: Option<Vec<HighlightLineDto>>,
    pub reason: Option<String>,
    pub theme_revision: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForegroundScopeResultDto {
    pub ok: bool,
    pub foreground: Option<HighlightColorDto>,
    pub reason: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffScopeBackgroundsDto {
    pub ok: bool,
    pub inserted: Option<HighlightColorDto>,
    pub deleted: Option<HighlightColorDto>,
    pub reason: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomThemeResultDto {
    pub ok: bool,
    pub reason: Option<String>,
}

pub struct HighlightCompactTask {
    source: String,
    language: String,
    theme: String,
}

impl Task for HighlightCompactTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            highlight_compact_source(&self.source, &self.language, &self.theme)
        }));
        Ok(result.unwrap_or_else(|_| compact_fallback("highlight_error")))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// CPU 密集型解析始终进入 N-API worker；结果以单个有界 Buffer 跨越 N-API 边界。
#[napi]
pub fn highlight_compact_async(
    source: String,
    language: String,
    theme: String,
) -> AsyncTask<HighlightCompactTask> {
    AsyncTask::new(HighlightCompactTask {
        source,
        language,
        theme,
    })
}

#[napi]
pub fn builtin_themes() -> Vec<String> {
    builtin_theme_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

#[napi]
pub fn foreground_for_scopes(theme: String, scopes: Vec<String>) -> ForegroundScopeResultDto {
    let scope_refs: Vec<&str> = scopes.iter().map(String::as_str).collect();
    foreground_for_scope_names(&theme, &scope_refs)
}

#[napi]
pub fn diff_scope_backgrounds(theme: String) -> DiffScopeBackgroundsDto {
    diff_scope_backgrounds_for_name(&theme)
}

#[napi]
pub fn register_custom_theme(name: String, bytes: Buffer) -> CustomThemeResultDto {
    register_custom_theme_bytes(&name, bytes.as_ref())
}

fn register_custom_theme_bytes(name: &str, bytes: &[u8]) -> CustomThemeResultDto {
    if !is_safe_theme_name(name) || bytes.is_empty() || bytes.len() > MAX_CUSTOM_THEME_BYTES {
        return custom_theme_failure();
    }
    let mut reader = Cursor::new(bytes);
    let Ok(theme) = ThemeSet::load_from_reader(&mut reader) else {
        return custom_theme_failure();
    };
    let Ok(mut themes) = custom_themes().write() else {
        return custom_theme_failure();
    };
    themes.insert(name.to_string(), Arc::new(theme));
    CustomThemeResultDto {
        ok: true,
        reason: None,
    }
}

fn custom_theme_failure() -> CustomThemeResultDto {
    CustomThemeResultDto {
        ok: false,
        reason: Some("theme_invalid".to_string()),
    }
}

fn is_safe_theme_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn diff_scope_backgrounds_for_name(theme: &str) -> DiffScopeBackgroundsDto {
    let Some(theme) = resolve_theme(theme) else {
        return DiffScopeBackgroundsDto {
            ok: false,
            inserted: None,
            deleted: None,
            reason: Some("theme_invalid".to_string()),
        };
    };
    let highlighter = Highlighter::new(theme.as_ref());
    DiffScopeBackgroundsDto {
        ok: true,
        inserted: scope_background(&highlighter, "markup.inserted")
            .or_else(|| scope_background(&highlighter, "diff.inserted")),
        deleted: scope_background(&highlighter, "markup.deleted")
            .or_else(|| scope_background(&highlighter, "diff.deleted")),
        reason: None,
    }
}

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(two_face::syntax::extra_newlines)
}

fn theme_set() -> &'static EmbeddedLazyThemeSet {
    THEME_SET.get_or_init(two_face::theme::extra)
}

fn custom_themes() -> &'static RwLock<HashMap<String, Arc<Theme>>> {
    CUSTOM_THEMES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn normalize_language(language: &str) -> &str {
    match language.to_ascii_lowercase().as_str() {
        "csharp" | "c-sharp" => "c#",
        "cppm" | "cxxm" | "ixx" => "cpp",
        "golang" => "go",
        "python3" => "python",
        "shell" => "bash",
        _ => language,
    }
}

fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
    let syntaxes = syntax_set();
    let patched = normalize_language(language);
    syntaxes
        .find_syntax_by_token(patched)
        .or_else(|| syntaxes.find_syntax_by_name(patched))
        .or_else(|| {
            let lower = patched.to_ascii_lowercase();
            syntaxes
                .syntaxes()
                .iter()
                .find(|syntax| syntax.name.to_ascii_lowercase() == lower)
        })
        .or_else(|| syntaxes.find_syntax_by_extension(language))
}

fn parse_theme_name(name: &str) -> Option<EmbeddedThemeName> {
    match name {
        "ansi" => Some(EmbeddedThemeName::Ansi),
        "base16" => Some(EmbeddedThemeName::Base16),
        "base16-256" => Some(EmbeddedThemeName::Base16_256),
        "base16-eighties-dark" => Some(EmbeddedThemeName::Base16EightiesDark),
        "base16-mocha-dark" => Some(EmbeddedThemeName::Base16MochaDark),
        "base16-ocean-dark" => Some(EmbeddedThemeName::Base16OceanDark),
        "base16-ocean-light" => Some(EmbeddedThemeName::Base16OceanLight),
        "catppuccin-frappe" => Some(EmbeddedThemeName::CatppuccinFrappe),
        "catppuccin-latte" => Some(EmbeddedThemeName::CatppuccinLatte),
        "catppuccin-macchiato" => Some(EmbeddedThemeName::CatppuccinMacchiato),
        "catppuccin-mocha" => Some(EmbeddedThemeName::CatppuccinMocha),
        "coldark-cold" => Some(EmbeddedThemeName::ColdarkCold),
        "coldark-dark" => Some(EmbeddedThemeName::ColdarkDark),
        "dark-neon" => Some(EmbeddedThemeName::DarkNeon),
        "dracula" => Some(EmbeddedThemeName::Dracula),
        "github" => Some(EmbeddedThemeName::Github),
        "gruvbox-dark" => Some(EmbeddedThemeName::GruvboxDark),
        "gruvbox-light" => Some(EmbeddedThemeName::GruvboxLight),
        "inspired-github" => Some(EmbeddedThemeName::InspiredGithub),
        "1337" => Some(EmbeddedThemeName::Leet),
        "monokai-extended" => Some(EmbeddedThemeName::MonokaiExtended),
        "monokai-extended-bright" => Some(EmbeddedThemeName::MonokaiExtendedBright),
        "monokai-extended-light" => Some(EmbeddedThemeName::MonokaiExtendedLight),
        "monokai-extended-origin" => Some(EmbeddedThemeName::MonokaiExtendedOrigin),
        "nord" => Some(EmbeddedThemeName::Nord),
        "one-half-dark" => Some(EmbeddedThemeName::OneHalfDark),
        "one-half-light" => Some(EmbeddedThemeName::OneHalfLight),
        "solarized-dark" => Some(EmbeddedThemeName::SolarizedDark),
        "solarized-light" => Some(EmbeddedThemeName::SolarizedLight),
        "sublime-snazzy" => Some(EmbeddedThemeName::SublimeSnazzy),
        "two-dark" => Some(EmbeddedThemeName::TwoDark),
        "zenburn" => Some(EmbeddedThemeName::Zenburn),
        _ => None,
    }
}

fn resolve_builtin_theme(name: &str) -> Option<&'static Theme> {
    parse_theme_name(name).map(|name| theme_set().get(name))
}

enum ResolvedTheme {
    Builtin(&'static Theme),
    Custom(Arc<Theme>),
}

impl AsRef<Theme> for ResolvedTheme {
    fn as_ref(&self) -> &Theme {
        match self {
            Self::Builtin(theme) => theme,
            Self::Custom(theme) => theme.as_ref(),
        }
    }
}

fn resolve_theme(name: &str) -> Option<ResolvedTheme> {
    if let Some(theme) = resolve_builtin_theme(name) {
        return Some(ResolvedTheme::Builtin(theme));
    }
    custom_themes()
        .read()
        .ok()?
        .get(name)
        .cloned()
        .map(ResolvedTheme::Custom)
}

fn builtin_theme_names() -> &'static [&'static str] {
    BUILTIN_THEME_NAMES
}

fn foreground_for_scope_names(theme: &str, scopes: &[&str]) -> ForegroundScopeResultDto {
    let Some(theme) = resolve_theme(theme) else {
        return ForegroundScopeResultDto {
            ok: false,
            foreground: None,
            reason: Some("theme_invalid".to_string()),
        };
    };
    let highlighter = Highlighter::new(theme.as_ref());
    let foreground = scopes.iter().find_map(|name| {
        let scope = Scope::new(name).ok()?;
        highlighter
            .style_mod_for_stack(&[scope])
            .foreground
            .map(color_to_dto)
    });
    ForegroundScopeResultDto {
        ok: true,
        foreground,
        reason: None,
    }
}

fn scope_background(highlighter: &Highlighter<'_>, name: &str) -> Option<HighlightColorDto> {
    let scope = Scope::new(name).ok()?;
    highlighter
        .style_mod_for_stack(&[scope])
        .background
        .map(color_to_dto)
}

fn classify_input(source: &str) -> Option<&'static str> {
    if source.is_empty() {
        Some("empty")
    } else if source.len() > MAX_HIGHLIGHT_BYTES {
        Some("oversize_bytes")
    } else if source.lines().count() > MAX_HIGHLIGHT_LINES {
        Some("oversize_lines")
    } else {
        None
    }
}

#[cfg(test)]
fn highlight_source(source: &str, language: &str, theme_name: &str) -> HighlightResultDto {
    if let Some(reason) = classify_input(source) {
        return fallback(reason);
    }
    let Some(syntax) = find_syntax(language) else {
        return fallback("unknown_language");
    };
    let Some(theme) = resolve_theme(theme_name) else {
        return fallback("theme_invalid");
    };

    let mut highlighter = HighlightLines::new(syntax, theme.as_ref());
    let mut lines = Vec::new();
    let mut span_count = 0usize;
    for line in LinesWithEndings::from(source) {
        let Ok(ranges) = highlighter.highlight_line(line, syntax_set()) else {
            return fallback("highlight_error");
        };
        let mut spans = Vec::new();
        for (style, text) in ranges {
            let text = text.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                continue;
            }
            span_count += 1;
            if span_count > MAX_HIGHLIGHT_SPANS {
                return fallback("highlight_error");
            }
            spans.push(style_to_span(style, text));
        }
        if spans.is_empty() {
            spans.push(style_to_span(Style::default(), ""));
        }
        lines.push(HighlightLineDto { spans });
    }

    HighlightResultDto {
        ok: true,
        lines: Some(lines),
        reason: None,
        theme_revision: Some(0),
    }
}

const COMPACT_MAGIC: &[u8; 4] = b"RLSH";
const COMPACT_VERSION: u8 = 1;
const COMPACT_STATUS_OK: u8 = 1;
const COMPACT_HEADER_BYTES: usize = 16;

fn highlight_compact_source(source: &str, language: &str, theme_name: &str) -> Vec<u8> {
    if let Some(reason) = classify_input(source) {
        return compact_fallback(reason);
    }
    let Some(syntax) = find_syntax(language) else {
        return compact_fallback("unknown_language");
    };
    let Some(theme) = resolve_theme(theme_name) else {
        return compact_fallback("theme_invalid");
    };

    let mut output = compact_header(COMPACT_STATUS_OK, 0);
    let highlighter = Highlighter::new(theme.as_ref());
    let mut parse_state = ParseState::new(syntax);
    let mut highlight_state = HighlightState::new(&highlighter, ScopeStack::new());
    let mut stable_line_cache: Option<(&str, Vec<u8>, u32)> = None;
    let mut line_count = 0u32;
    let mut span_count = 0u32;
    for line in LinesWithEndings::from(source) {
        line_count = line_count.saturating_add(1);
        if let Some((cached_line, cached_bytes, cached_spans)) = &stable_line_cache {
            if line == *cached_line {
                span_count = span_count.saturating_add(*cached_spans);
                if span_count as usize > MAX_HIGHLIGHT_SPANS {
                    return compact_fallback("highlight_error");
                }
                output.extend_from_slice(cached_bytes);
                continue;
            }
        }

        let parse_before = parse_state.clone();
        let highlight_before = highlight_state.clone();
        let Ok(ops) = parse_state.parse_line(line, syntax_set()) else {
            return compact_fallback("highlight_error");
        };
        let ranges = HighlightIterator::new(&mut highlight_state, &ops, line, &highlighter);
        let encoded_line_offset = output.len();
        let line_span_count_offset = output.len();
        push_u32(&mut output, 0);
        let mut line_span_count = 0u32;
        let mut previous_style = None;
        let mut previous_length_offset = None;
        for (style, text) in ranges {
            let text = text.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                continue;
            }
            let style_word = style_to_word(style);
            if previous_style == Some(style_word) {
                let Some(length_offset) = previous_length_offset else {
                    return compact_fallback("highlight_error");
                };
                let previous_length = read_u32(&output, length_offset);
                let Ok(text_length) = u32::try_from(text.len()) else {
                    return compact_fallback("highlight_error");
                };
                overwrite_u32(
                    &mut output,
                    length_offset,
                    previous_length.saturating_add(text_length),
                );
                output.extend_from_slice(text.as_bytes());
                continue;
            }
            span_count = span_count.saturating_add(1);
            if span_count as usize > MAX_HIGHLIGHT_SPANS {
                return compact_fallback("highlight_error");
            }
            line_span_count = line_span_count.saturating_add(1);
            let Ok(text_length) = u32::try_from(text.len()) else {
                return compact_fallback("highlight_error");
            };
            let length_offset = output.len();
            push_u32(&mut output, text_length);
            push_u32(&mut output, style_word);
            output.extend_from_slice(text.as_bytes());
            previous_style = Some(style_word);
            previous_length_offset = Some(length_offset);
        }
        if line_span_count == 0 {
            span_count = span_count.saturating_add(1);
            line_span_count = 1;
            push_u32(&mut output, 0);
            push_u32(&mut output, 0);
        }
        overwrite_u32(&mut output, line_span_count_offset, line_span_count);
        stable_line_cache = if parse_state == parse_before && highlight_state == highlight_before {
            Some((line, output[encoded_line_offset..].to_vec(), line_span_count))
        } else {
            None
        };
    }
    overwrite_u32(&mut output, 8, line_count);
    overwrite_u32(&mut output, 12, span_count);
    output
}

fn compact_header(status: u8, reason: u8) -> Vec<u8> {
    let mut output = Vec::with_capacity(COMPACT_HEADER_BYTES);
    output.extend_from_slice(COMPACT_MAGIC);
    output.push(COMPACT_VERSION);
    output.push(status);
    output.push(reason);
    output.push(0);
    push_u32(&mut output, 0);
    push_u32(&mut output, 0);
    output
}

fn compact_fallback(reason: &str) -> Vec<u8> {
    compact_header(0, fallback_reason_code(reason))
}

fn fallback_reason_code(reason: &str) -> u8 {
    match reason {
        "empty" => 1,
        "unknown_language" => 2,
        "oversize_bytes" => 3,
        "oversize_lines" => 4,
        "theme_invalid" => 5,
        _ => 6,
    }
}

fn style_to_word(style: Style) -> u32 {
    let bold = if style.font_style.contains(FontStyle::BOLD) {
        1u32 << 2
    } else {
        0
    };
    match style.foreground.a {
        ANSI_ALPHA_DEFAULT => bold,
        ANSI_ALPHA_INDEX => 1 | bold | (u32::from(style.foreground.r) << 8),
        _ => {
            2 | bold
                | (u32::from(style.foreground.r) << 8)
                | (u32::from(style.foreground.g) << 16)
                | (u32::from(style.foreground.b) << 24)
        }
    }
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn overwrite_u32(output: &mut [u8], offset: usize, value: u32) {
    output[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(output: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(output[offset..offset + 4].try_into().unwrap_or_default())
}

#[cfg(test)]
fn style_to_span(style: Style, text: &str) -> HighlightSpanDto {
    HighlightSpanDto {
        text: text.to_string(),
        foreground: color_to_dto(style.foreground),
        bold: style.font_style.contains(FontStyle::BOLD),
    }
}

fn color_to_dto(color: Color) -> HighlightColorDto {
    match color.a {
        ANSI_ALPHA_INDEX => indexed_color(color.r),
        ANSI_ALPHA_DEFAULT => default_color(),
        OPAQUE_ALPHA => rgb_color(color.r, color.g, color.b),
        _ => rgb_color(color.r, color.g, color.b),
    }
}

fn default_color() -> HighlightColorDto {
    HighlightColorDto {
        kind: "default".to_string(),
        index: None,
        r: None,
        g: None,
        b: None,
    }
}

fn indexed_color(index: u8) -> HighlightColorDto {
    HighlightColorDto {
        kind: "indexed".to_string(),
        index: Some(u32::from(index)),
        r: None,
        g: None,
        b: None,
    }
}

fn rgb_color(r: u8, g: u8, b: u8) -> HighlightColorDto {
    HighlightColorDto {
        kind: "rgb".to_string(),
        index: None,
        r: Some(u32::from(r)),
        g: Some(u32::from(g)),
        b: Some(u32::from(b)),
    }
}

#[cfg(test)]
fn fallback(reason: &str) -> HighlightResultDto {
    HighlightResultDto {
        ok: false,
        lines: None,
        reason: Some(reason.to_string()),
        theme_revision: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syntect::highlighting::{Color, FontStyle, Style};

    const CUSTOM_THEME: &[u8] = br##"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>name</key><string>RunLedger Fixture</string><key>settings</key><array>
<dict><key>settings</key><dict><key>foreground</key><string>#112233</string></dict></dict>
<dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#123456</string></dict></dict>
<dict><key>scope</key><string>markup.inserted</string><key>settings</key><dict><key>background</key><string>#214365</string></dict></dict>
<dict><key>scope</key><string>markup.deleted</string><key>settings</key><dict><key>background</key><string>#654321</string></dict></dict>
</array></dict></plist>"##;

    const EXPECTED_THEMES: &[&str] = &[
        "1337",
        "ansi",
        "base16",
        "base16-256",
        "base16-eighties-dark",
        "base16-mocha-dark",
        "base16-ocean-dark",
        "base16-ocean-light",
        "catppuccin-frappe",
        "catppuccin-latte",
        "catppuccin-macchiato",
        "catppuccin-mocha",
        "coldark-cold",
        "coldark-dark",
        "dark-neon",
        "dracula",
        "github",
        "gruvbox-dark",
        "gruvbox-light",
        "inspired-github",
        "monokai-extended",
        "monokai-extended-bright",
        "monokai-extended-light",
        "monokai-extended-origin",
        "nord",
        "one-half-dark",
        "one-half-light",
        "solarized-dark",
        "solarized-light",
        "sublime-snazzy",
        "two-dark",
        "zenburn",
    ];

    #[test]
    fn patches_only_the_codex_language_aliases() {
        for (input, expected) in [
            ("csharp", "c#"),
            ("c-sharp", "c#"),
            ("cppm", "cpp"),
            ("cxxm", "cpp"),
            ("ixx", "cpp"),
            ("golang", "go"),
            ("python3", "python"),
            ("shell", "bash"),
        ] {
            assert_eq!(normalize_language(input), expected);
            assert!(find_syntax(input).is_some(), "missing alias {input}");
        }
        assert_eq!(normalize_language("Rust"), "Rust");
    }

    #[test]
    fn resolves_tokens_names_case_insensitive_names_and_extensions() {
        assert_eq!(
            find_syntax("rs").map(|syntax| syntax.name.as_str()),
            Some("Rust")
        );
        assert_eq!(
            find_syntax("Rust").map(|syntax| syntax.name.as_str()),
            Some("Rust")
        );
        assert_eq!(
            find_syntax("rust").map(|syntax| syntax.name.as_str()),
            Some("Rust")
        );
        assert!(find_syntax("definitely-not-a-language").is_none());
    }

    #[test]
    fn rejects_empty_unknown_and_inputs_over_each_strict_limit() {
        assert_eq!(
            highlight_source("", "rust", "catppuccin-mocha"),
            fallback("empty")
        );
        assert_eq!(
            highlight_source("hello", "definitely-not-a-language", "catppuccin-mocha"),
            fallback("unknown_language")
        );
        assert_eq!(
            classify_input(&"x".repeat(MAX_HIGHLIGHT_BYTES + 1)),
            Some("oversize_bytes")
        );
        assert_eq!(
            classify_input(&"x\n".repeat(MAX_HIGHLIGHT_LINES + 1)),
            Some("oversize_lines")
        );
    }

    #[test]
    fn accepts_exact_limits_and_counts_a_non_terminated_final_line() {
        assert_eq!(classify_input(&"x".repeat(MAX_HIGHLIGHT_BYTES)), None);
        assert_eq!(classify_input(&"x\n".repeat(MAX_HIGHLIGHT_LINES)), None);

        let no_trailing_newline = format!("{}x", "x\n".repeat(MAX_HIGHLIGHT_LINES));
        assert_eq!(no_trailing_newline.lines().count(), MAX_HIGHLIGHT_LINES + 1);
        assert_eq!(classify_input(&no_trailing_newline), Some("oversize_lines"));
    }

    #[test]
    fn strips_crlf_without_changing_source_line_text() {
        let result = highlight_source("fn main() {}\r\nlet x = 1;\r\n", "rust", "catppuccin-mocha");
        let lines = result.lines.expect("highlighted lines");
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0]
                .spans
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>(),
            "fn main() {}"
        );
        assert_eq!(
            lines[1]
                .spans
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>(),
            "let x = 1;"
        );
        assert!(
            lines
                .iter()
                .flat_map(|line| &line.spans)
                .all(|span| !span.text.contains(['\r', '\n']))
        );
    }

    #[test]
    fn exposes_exactly_the_codex_builtin_theme_inventory() {
        assert_eq!(builtin_theme_names(), EXPECTED_THEMES);
        for name in EXPECTED_THEMES {
            assert!(
                resolve_builtin_theme(name).is_some(),
                "theme did not resolve: {name}"
            );
        }
        assert!(resolve_builtin_theme("unknown-theme").is_none());
    }

    #[test]
    fn decodes_bat_alpha_markers_without_flattening_indexed_intent() {
        assert_eq!(
            color_to_dto(Color {
                r: 6,
                g: 99,
                b: 88,
                a: 0
            }),
            indexed_color(6)
        );
        assert_eq!(
            color_to_dto(Color {
                r: 1,
                g: 2,
                b: 3,
                a: 1
            }),
            default_color()
        );
        assert_eq!(
            color_to_dto(Color {
                r: 1,
                g: 2,
                b: 3,
                a: 255
            }),
            rgb_color(1, 2, 3)
        );
        assert_eq!(
            color_to_dto(Color {
                r: 4,
                g: 5,
                b: 6,
                a: 42
            }),
            rgb_color(4, 5, 6)
        );
    }

    #[test]
    fn projects_only_foreground_and_bold_from_syntect_style() {
        let style = Style {
            foreground: Color {
                r: 1,
                g: 2,
                b: 3,
                a: 255,
            },
            background: Color {
                r: 200,
                g: 201,
                b: 202,
                a: 255,
            },
            font_style: FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE,
        };
        let span = style_to_span(style, "value");
        assert_eq!(span.text, "value");
        assert_eq!(span.foreground, rgb_color(1, 2, 3));
        assert!(span.bold);

        let italic_only = Style {
            font_style: FontStyle::ITALIC | FontStyle::UNDERLINE,
            ..style
        };
        assert!(!style_to_span(italic_only, "value").bold);
    }

    #[test]
    fn resolves_the_first_defined_status_scope_and_diff_backgrounds() {
        let path = foreground_for_scope_names("catppuccin-mocha", &["not.a.scope", "string"]);
        assert!(path.ok);
        assert_eq!(path.foreground, Some(rgb_color(166, 227, 161)));

        let no_scope = foreground_for_scope_names("catppuccin-mocha", &["not.a.scope"]);
        assert!(no_scope.ok);
        assert_eq!(no_scope.foreground, None);

        let invalid = foreground_for_scope_names("missing", &["string"]);
        assert!(!invalid.ok);
        assert_eq!(invalid.reason.as_deref(), Some("theme_invalid"));

        let diff = diff_scope_backgrounds_for_name("catppuccin-mocha");
        assert!(diff.ok);
    }

    #[test]
    fn registered_custom_theme_drives_highlight_foreground_and_diff_scopes() {
        let registered = register_custom_theme_bytes("runledger-fixture", CUSTOM_THEME);
        assert!(registered.ok);

        let foreground = foreground_for_scope_names("runledger-fixture", &["string"]);
        assert_eq!(foreground.foreground, Some(rgb_color(0x12, 0x34, 0x56)));

        let highlighted = highlight_source("let value = \"audit\";", "rust", "runledger-fixture");
        assert!(highlighted.ok);
        assert!(
            highlighted
                .lines
                .unwrap_or_default()
                .iter()
                .flat_map(|line| &line.spans)
                .any(|span| span.foreground == rgb_color(0x12, 0x34, 0x56))
        );

        let diff = diff_scope_backgrounds_for_name("runledger-fixture");
        assert!(diff.ok);
        assert_eq!(diff.inserted, Some(rgb_color(0x21, 0x43, 0x65)));
        assert_eq!(diff.deleted, Some(rgb_color(0x65, 0x43, 0x21)));
    }

    #[test]
    fn rejects_path_like_custom_theme_names() {
        assert!(!register_custom_theme_bytes("bad..name", CUSTOM_THEME).ok);
        assert!(!register_custom_theme_bytes("../outside", CUSTOM_THEME).ok);
    }
}
#[test]
fn engine_identity_includes_a_bounded_build_id() {
    let info = engine_info();
    assert!(!info.engine_build_id.is_empty());
    assert!(info.engine_build_id.len() <= 128);
    assert!(
        info.engine_build_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "@._:+-".contains(character))
    );
}
