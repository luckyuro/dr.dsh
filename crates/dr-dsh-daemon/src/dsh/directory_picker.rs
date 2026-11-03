//! Adapt only DSH's shipped automatic picker to its supported remote browser.
//!
//! A daemon's loopback listener does not mean its user can see the host display.
//! DSH owns the browser and host filesystem implementation; this overlay selects
//! that pair without changing the user's persistent patch or package manifest.

use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;

use serde_yaml::Value;
use tempfile::NamedTempFile;
use tokio::io::AsyncReadExt as _;
use tokio::process::Command;

use super::supervisor::{SuperviseError, SupervisorConfig};

const INSPECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const AUTO_PICKER: &str = "@deepseek-ai/dsh-host-directory-picker-auto";
const OVERLAY: &str = "\
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- insert:
    - id: drdsh-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: drdsh-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
";

pub(super) async fn prepare(
    config: &SupervisorConfig,
) -> Result<Option<NamedTempFile>, SuperviseError> {
    let contents = inspect(config, INSPECT_TIMEOUT).await?;
    if !needs_overlay(&contents)? {
        return Ok(None);
    }
    create_overlay().map(Some)
}

async fn inspect(config: &SupervisorConfig, timeout: Duration) -> Result<Vec<u8>, SuperviseError> {
    // The official dump composes installed bundles and both user patch layers.
    // It performs DSH's normal generated-root maintenance but mounts no plugins.
    // Do not give this inspection process reporting credentials, and never log
    // its output: unrelated profile rows may contain account secrets.
    let mut child = Command::new(&config.executable)
        .args(["web", "--dump-config"])
        .env_remove(crate::reports::ENV_URL)
        .env_remove(crate::reports::ENV_TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|source| SuperviseError::Spawn {
            executable: config.executable.display().to_string(),
            source,
        })?;
    let stdout = child.stdout.take().ok_or(configuration_error(
        "the configuration inspector did not provide an output stream",
    ))?;
    let result = tokio::time::timeout(timeout, async {
        let mut contents = Vec::new();
        stdout
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut contents)
            .await
            .map_err(|_| configuration_error("the configuration output could not be read"))?;
        if contents.len() as u64 > MAX_CONFIG_BYTES {
            return Err(configuration_error(
                "the configuration output exceeds 4 MiB",
            ));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| configuration_error("the configuration inspector could not be reaped"))?;
        if !status.success() {
            return Err(configuration_error(
                "the configuration inspector exited unsuccessfully",
            ));
        }
        Ok(contents)
    })
    .await;
    match result {
        Ok(Ok(contents)) => Ok(contents),
        result => {
            // Reap even timeout and output-limit failures before starting again.
            let _ = child.kill().await;
            result.unwrap_or_else(|_| {
                Err(configuration_error(
                    "the configuration inspector exceeded its time limit",
                ))
            })
        }
    }
}

fn needs_overlay(contents: &[u8]) -> Result<bool, SuperviseError> {
    let config: Value = serde_yaml::from_slice(contents)
        .map_err(|_| configuration_error("the configuration output is not valid YAML"))?;
    let rows = config.as_sequence().ok_or(configuration_error(
        "the configuration output is not a plugin row list",
    ))?;
    let mut automatic = 0;
    let mut pending = vec![(rows, true, true)];
    while let Some((rows, parent_enabled, top_level)) = pending.pop() {
        for row in rows {
            let row = row.as_mapping().ok_or(configuration_error(
                "the configuration output contains an invalid plugin row",
            ))?;
            let id = row.get("id").and_then(Value::as_str);
            let name = row.get("name").and_then(Value::as_str);
            // Cordis groups share their parent's ID store, even for disabled
            // entries. A top-level insert must never reuse a user's nested ID.
            if matches!(
                id,
                Some("drdsh-directory-picker" | "drdsh-directory-picker-ui")
            ) || (!top_level && id == Some("directory-picker"))
            {
                return Ok(false);
            }
            let group = row.get("group").and_then(Value::as_bool) == Some(true)
                || matches!(
                    name,
                    Some("cordis:group" | "@deepseek-ai/cordis-plugin-group")
                );
            let picker = name.is_some_and(|name| {
                name.starts_with("@deepseek-ai/dsh-host-directory-picker-")
                    || name.starts_with("@deepseek-ai/dsh-client-ui-directory-picker-")
            });
            let literal_disabled = row
                .get("disabled")
                .is_none_or(|value| matches!(value, Value::Null | Value::Bool(_)));
            // The static dump does not expand include files or evaluate user
            // expressions. Preserve those picker compositions rather than guess
            // which providers or IDs they will create at runtime.
            if matches!(
                name,
                Some("cordis:include" | "@deepseek-ai/cordis-plugin-include")
            ) || ((group || picker) && !literal_disabled)
                || (group
                    && row
                        .get("config")
                        .is_some_and(|value| !matches!(value, Value::Sequence(_))))
            {
                return Ok(false);
            }
            let enabled = parent_enabled
                && row
                    .get("disabled")
                    .is_none_or(|value| value.is_null() || value.as_bool() == Some(false));
            if group && let Some(children) = row.get("config").and_then(Value::as_sequence) {
                pending.push((children, enabled, false));
            }
            if !enabled {
                continue;
            }
            if matches!(
                name,
                Some(
                    "@deepseek-ai/dsh-host-directory-picker-native"
                        | "@deepseek-ai/dsh-host-directory-picker-browse"
                        | "@deepseek-ai/dsh-client-ui-directory-picker-native"
                        | "@deepseek-ai/dsh-client-ui-directory-picker-browse"
                )
            ) {
                return Ok(false);
            }
            if name == Some(AUTO_PICKER) {
                if id != Some("directory-picker") || !top_level {
                    return Ok(false);
                }
                automatic += 1;
            }
        }
    }
    Ok(automatic == 1)
}

fn create_overlay() -> Result<NamedTempFile, SuperviseError> {
    // NamedTempFile uses exclusive creation and owner-only permissions on Unix.
    // Keep its handle with the child because Loader may read the overlay again.
    let mut file = tempfile::Builder::new()
        .prefix("drdsh-directory-picker-")
        .suffix(".yml")
        .tempfile()
        .map_err(SuperviseError::Overlay)?;
    file.write_all(OVERLAY.as_bytes())
        .map_err(SuperviseError::Overlay)?;
    file.flush().map_err(SuperviseError::Overlay)?;
    Ok(file)
}

fn configuration_error(reason: &'static str) -> SuperviseError {
    SuperviseError::Configuration { reason }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn only_the_enabled_default_automatic_picker_is_adapted() -> TestResult {
        assert!(needs_overlay(
            format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n").as_bytes()
        )?);
        assert!(needs_overlay(
            format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n  disabled: false\n")
                .as_bytes()
        )?);
        assert!(needs_overlay(
            format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n  disabled: null\n")
                .as_bytes()
        )?);
        for config in [
            "[]".to_owned(),
            format!("- id: custom-picker\n  name: '{AUTO_PICKER}'\n"),
            format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n  disabled: true\n"),
            "- id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-native'\n"
                .to_owned(),
            "- id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-browse'\n"
                .to_owned(),
            format!(
                "- id: directory-picker\n  name: '{AUTO_PICKER}'\n- id: custom\n  name: '@deepseek-ai/dsh-host-directory-picker-browse'\n"
            ),
            format!(
                "- id: directory-picker\n  name: '{AUTO_PICKER}'\n- id: drdsh-directory-picker\n  name: custom\n"
            ),
        ] {
            assert!(!needs_overlay(config.as_bytes())?, "{config}");
        }
        Ok(())
    }

    #[test]
    fn malformed_configuration_never_enters_diagnostics() {
        for contents in ["secret-value: [", "secret-value: true", "- secret-value"] {
            let Err(error) = needs_overlay(contents.as_bytes()) else {
                unreachable!("an invalid configuration must fail");
            };
            assert!(!error.to_string().contains("secret-value"));
            assert!(!format!("{error:?}").contains("secret-value"));
        }
    }

    #[test]
    fn groups_cannot_hide_user_picker_entries_or_id_collisions() -> TestResult {
        let default = format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n");
        for group in [
            "group: true",
            "name: cordis:group",
            "name: '@deepseek-ai/cordis-plugin-group'",
        ] {
            for disabled in ["false", "true"] {
                let contents = format!(
                    "{default}- id: user-group\n  {group}\n  disabled: {disabled}\n  config:\n    - id: drdsh-directory-picker\n      name: user-plugin\n"
                );
                assert!(!needs_overlay(contents.as_bytes())?);
            }
        }
        let explicit = format!(
            "{default}- id: user-group\n  group: true\n  config:\n    - id: user-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n"
        );
        assert!(!needs_overlay(explicit.as_bytes())?);
        let disabled = format!(
            "{default}- id: user-group\n  group: true\n  disabled: true\n  config:\n    - id: user-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n"
        );
        assert!(needs_overlay(disabled.as_bytes())?);
        Ok(())
    }

    #[test]
    fn unknown_picker_compositions_are_preserved_without_disabling_default_expressions()
    -> TestResult {
        let default = format!("- id: directory-picker\n  name: '{AUTO_PICKER}'\n");
        for custom in [
            "- id: extra\n  name: cordis:include\n  config: user.yml\n",
            "- id: extra\n  name: '@deepseek-ai/cordis-plugin-include'\n  disabled: true\n  config: user.yml\n",
            "- id: extra\n  group: true\n  disabled: !js false\n  config: []\n",
            "- id: extra\n  group: true\n  config: !js entries\n",
            "- id: extra\n  name: '@deepseek-ai/dsh-host-directory-picker-native'\n  disabled: !js false\n",
        ] {
            assert!(!needs_overlay(format!("{default}{custom}").as_bytes())?);
        }
        assert!(needs_overlay(
            format!("{default}- id: optional-ui\n  name: optional-ui\n  disabled: !js false\n")
                .as_bytes()
        )?);
        Ok(())
    }

    #[test]
    fn the_overlay_is_private_and_removed_on_drop() -> TestResult {
        let overlay = create_overlay()?;
        let path = overlay.path().to_path_buf();
        assert_eq!(std::fs::read_to_string(&path)?, OVERLAY);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&path)?.permissions().mode() & 0o777,
                0o600
            );
        }
        drop(overlay);
        assert!(!path.exists());
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inspection_failures_are_bounded_and_do_not_expose_output() -> TestResult {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir()?;
        for (name, script, timeout, expected) in [
            (
                "failed",
                "printf 'secret-output'; printf 'secret-error' >&2; exit 17",
                Duration::from_secs(2),
                "exited unsuccessfully",
            ),
            (
                "timeout",
                "exec sleep 30",
                Duration::from_millis(50),
                "time limit",
            ),
            (
                "oversized",
                "exec head -c 4194305 /dev/zero",
                Duration::from_secs(2),
                "exceeds 4 MiB",
            ),
        ] {
            let executable = directory.path().join(name);
            std::fs::write(&executable, format!("#!/bin/sh\n{script}\n"))?;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))?;
            let config = SupervisorConfig {
                executable,
                port: 3080,
            };
            let Err(error) = inspect(&config, timeout).await else {
                unreachable!("inspection should have failed");
            };
            assert!(error.to_string().contains(expected), "{error}");
            assert!(!error.to_string().contains("secret"));
            assert!(!format!("{error:?}").contains("secret"));
        }
        Ok(())
    }
}
