//! An `OpenAPI` contract as the YAML a repository commits, and the binary that prints it.

use std::io::Write;
use std::process::ExitCode;

use utoipa::openapi::{OpenApi, OpenApiVersion};

/// `contract` as `OpenAPI` 3.2 YAML, with every bare date or timestamp quoted.
/// # Errors
/// A message, when the contract cannot be serialised.
pub fn yaml(mut contract: OpenApi) -> Result<String, String> {
    contract.openapi = OpenApiVersion::Version32;
    let yaml = contract.to_yaml().map_err(|err| err.to_string())?;
    Ok(yaml
        .lines()
        .map(quoted_dates)
        .fold(String::new(), |mut out, line| {
            out.push_str(&line);
            out.push('\n');
            out
        }))
}

/// Prints `yaml` on standard output, for a repository's export binary, whose output a check
/// compares with the committed file. A failure is told on standard error, under `program`.
#[must_use]
pub fn print(program: &str, yaml: Result<String, String>) -> ExitCode {
    let printed = yaml.and_then(|yaml| {
        let written = std::io::stdout().lock().write_all(yaml.as_bytes());
        written.map_err(|err| err.to_string())
    });
    match printed {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            let told = writeln!(std::io::stderr().lock(), "{program}: {err}");
            drop(told);
            ExitCode::FAILURE
        }
    }
}

/// A line whose value is a bare date or timestamp, quoted: YAML 1.1 loaders such as js-yaml, used
/// by documentation tools, would load it as a date, not the string the schema says it holds.
fn quoted_dates(line: &str) -> String {
    let member = line.find(": ").map(|colon| colon.saturating_add(2));
    let item = line.trim_start().strip_prefix("- ");
    let value_at = member.or_else(|| item.map(|value| line.len().saturating_sub(value.len())));
    match value_at.and_then(|at| line.split_at_checked(at)) {
        Some((key, value)) if is_date(value) => format!("{key}'{value}'"),
        _ => line.to_owned(),
    }
}

/// `YYYY-MM-DD`, alone or opening an RFC 3339 timestamp.
fn is_date(value: &str) -> bool {
    let date = value.get(..10).unwrap_or_default();
    let shaped = date.char_indices().all(|(at, character)| match at {
        4 | 7 => character == '-',
        _ => character.is_ascii_digit(),
    });
    let rest = value.get(10..).unwrap_or_default();
    date.len() == 10 && shaped && (rest.is_empty() || rest.starts_with('T'))
}

#[cfg(test)]
mod tests {
    use std::process::ExitCode;

    use utoipa::openapi::OpenApiBuilder;
    use utoipa::openapi::info::InfoBuilder;

    use super::{print, quoted_dates, yaml};

    #[test]
    fn bare_dates_are_quoted_and_nothing_else_is() {
        let quoted = "  createdAt: '2026-10-08T09:30:00Z'";
        assert_eq!(quoted_dates("  createdAt: 2026-10-08T09:30:00Z"), quoted);
        assert_eq!(quoted_dates("    - 2026-10-06"), "    - '2026-10-06'");
        let kept = [
            quoted,
            "  title: 2026 plans",
            "    The note: it is 2026-10-06 here",
            "  version: 1.0.0",
            "    - 2026-10-06 was a day",
        ];
        for line in kept {
            assert_eq!(quoted_dates(line), line);
        }
    }

    #[test]
    fn a_contract_is_written_as_openapi_3_2() -> Result<(), String> {
        let info = InfoBuilder::new()
            .title("Example")
            .version("2026-01-05")
            .build();
        let written = yaml(OpenApiBuilder::new().info(info).build())?;
        assert!(written.starts_with("openapi: 3.2.0\n"), "{written}");
        assert!(written.contains("  version: '2026-01-05'\n"), "{written}");
        Ok(())
    }

    #[test]
    fn a_failed_export_says_so_in_its_exit_status() {
        assert_eq!(print("export", Err("broken".to_owned())), ExitCode::FAILURE);
        assert_eq!(print("export", Ok(String::new())), ExitCode::SUCCESS);
    }
}
