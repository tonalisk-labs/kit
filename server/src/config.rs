//! Configuration: a JSON file, then the environment variables that override its settings, each
//! setting named by its JSON Pointer.

use std::env::{self, VarError};

use serde::de::DeserializeOwned;
use serde_json::Value;

/// An environment variable, and the JSON Pointer of the setting it overrides.
pub type Override = (&'static str, &'static str);

/// A configuration file's settings, named by where they came from in every error.
#[derive(Debug)]
pub struct Settings {
    /// The settings, overrides applied.
    pub tree: Value,
    /// The file's path, or the name of a file compiled in.
    pub origin: String,
}

impl Settings {
    /// Reads the file at `path`, which must hold JSON.
    /// # Errors
    pub fn read(path: &str) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|err| format!("reading {path}: {err}"))?;
        Self::parse(&text, path)
    }

    /// Parses `text`, which `origin` names, as JSON.
    /// # Errors
    pub fn parse(text: &str, origin: &str) -> Result<Self, String> {
        let tree = serde_json::from_str(text).map_err(|err| format!("parsing {origin}: {err}"))?;
        let origin = origin.to_owned();
        Ok(Self { tree, origin })
    }

    /// These settings with `over`'s written on top: objects merge member by member, and any other
    /// value of `over` replaces the one here.
    #[must_use]
    pub fn merged(mut self, over: Self) -> Self {
        merge(&mut self.tree, over.tree);
        self.origin = format!("{} + {}", self.origin, over.origin);
        self
    }

    /// Writes each variable `lookup` finds over the setting it names, as a number where it is one.
    /// # Errors
    pub fn overridden(
        mut self,
        overrides: &[Override],
        lookup: impl Fn(&str) -> Result<Option<String>, String>,
    ) -> Result<Self, String> {
        for &(variable, pointer) in overrides {
            let Some(raw) = lookup(variable)? else {
                continue;
            };
            let refused = || format!("{variable} cannot override {}'s {pointer}", self.origin);
            let slot = self.tree.pointer_mut(pointer).ok_or_else(refused)?;
            *slot = if slot.is_number() {
                serde_json::from_str(&raw).map_err(|err| format!("{}: {err}", refused()))?
            } else {
                Value::String(raw)
            };
        }
        Ok(self)
    }

    /// The setting at `pointer`, which must be a `T`.
    /// # Errors
    pub fn get<T: DeserializeOwned>(&self, pointer: &str) -> Result<T, String> {
        let origin = &self.origin;
        let value = self.tree.pointer(pointer);
        let value = value.ok_or_else(|| format!("{origin}: {pointer} is missing"))?;
        T::deserialize(value).map_err(|err| format!("{origin}: {pointer} {err}"))
    }

    /// The whole file as a `T`; an error names the member at fault.
    /// # Errors
    pub fn file<T: DeserializeOwned>(&self) -> Result<T, String> {
        serde_path_to_error::deserialize(&self.tree)
            .map_err(|err| format!("{}: {} {}", self.origin, err.path(), err.inner()))
    }
}

fn merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(base), Value::Object(over)) => {
            for (key, value) in over {
                match base.get_mut(&key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (base, over) => *base = over,
    }
}

/// An environment variable: absent is `None`, and a value that is not Unicode is refused.
/// # Errors
pub fn var(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(VarError::NotPresent) => Ok(None),
        Err(VarError::NotUnicode(_)) => Err(format!("{name} is not valid Unicode")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{Override, Settings};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    const FILE: &str = r#"{"network": {"bind_addr": "127.0.0.1:8080", "port": 8080}}"#;

    fn overridden(overrides: &[Override], raw: &str) -> Result<Settings, String> {
        let found = |_: &str| Ok(Some(raw.to_owned()));
        Settings::parse(FILE, "test.json")?.overridden(overrides, found)
    }

    #[test]
    fn settings_merge_member_by_member_and_the_later_wins() -> Result<(), String> {
        let base = Settings::parse(
            r#"{"a": {"x": 1, "y": 2}, "b": [1, 2], "c": "kept"}"#,
            "base",
        )?;
        let over = Settings::parse(r#"{"a": {"y": 3, "z": 4}, "b": [9]}"#, "over")?;
        let merged = base.merged(over);
        assert_eq!(merged.get::<u32>("/a/x")?, 1);
        assert_eq!(merged.get::<u32>("/a/y")?, 3);
        assert_eq!(merged.get::<u32>("/a/z")?, 4);
        assert_eq!(merged.get::<Vec<u32>>("/b")?, vec![9]);
        assert_eq!(merged.get::<String>("/c")?, "kept");
        assert_eq!(
            merged.get::<u32>("/a/w"),
            Err("base + over: /a/w is missing".to_owned())
        );
        Ok(())
    }

    /// One naming no setting, or giving a number's setting other text, is refused by name.
    #[test]
    fn an_override_lands_on_its_setting_in_its_type() -> TestResult {
        let both = [("PORT", "/network/port"), ("BIND", "/network/bind_addr")];
        let settings = overridden(&both, "9090")?;
        assert_eq!(settings.get::<u16>("/network/port")?, 9090);
        assert_eq!(settings.get::<String>("/network/bind_addr")?, "9090");
        let refusals = [
            (overridden(&[("HOST", "/network/host")], "x"), "HOST"),
            (overridden(&[("PORT", "/network/port")], "x"), "PORT"),
        ];
        for (refused, variable) in refusals {
            let err = refused.err().unwrap_or_default();
            assert!(err.starts_with(&format!("{variable} cannot override test.json's")));
        }
        let unset = |_: &str| Ok(None);
        let kept = Settings::parse(FILE, "test.json")?.overridden(&both, unset)?;
        assert_eq!(kept.get::<u16>("/network/port")?, 8080);
        Ok(())
    }

    #[test]
    fn an_error_names_the_file_and_the_setting() -> TestResult {
        let settings = Settings::parse(FILE, "test.json")?;
        let missing = settings.get::<String>("/network/host").err();
        assert_eq!(
            missing.as_deref(),
            Some("test.json: /network/host is missing")
        );
        let mistyped = settings.get::<u16>("/network/bind_addr").err();
        assert!(mistyped.is_some_and(|err| err.starts_with("test.json: /network/bind_addr ")));
        let wrong = Settings::parse(r#"{"network": {"port": "x"}}"#, "test.json")?;
        let member = wrong
            .file::<BTreeMap<String, BTreeMap<String, u16>>>()
            .err();
        assert!(member.is_some_and(|err| err.starts_with("test.json: network.port ")));
        assert!(Settings::parse("{", "test.json").is_err_and(|err| err.starts_with("parsing")));
        Ok(())
    }
}
