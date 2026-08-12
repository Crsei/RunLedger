use sha2::{Digest, Sha256};
use std::error::Error;
use std::fs;

const IDENTITY_FILES: &[(&str, &str)] = &[
    ("src/lib.rs", "cargo:rerun-if-changed=src/lib.rs"),
    ("Cargo.toml", "cargo:rerun-if-changed=Cargo.toml"),
    ("Cargo.lock", "cargo:rerun-if-changed=Cargo.lock"),
    ("build.rs", "cargo:rerun-if-changed=build.rs"),
];

fn main() -> Result<(), Box<dyn Error>> {
    let mut identity = Sha256::new();
    for (path, rerun_directive) in IDENTITY_FILES {
        println!("{rerun_directive}");
        identity.update(path.as_bytes());
        identity.update([0]);
        identity.update(fs::read(path)?);
    }
    let source_id = format!("{:x}", identity.finalize());
    println!(
        "cargo:rustc-env=RUNLEDGER_SYNTAX_ENGINE_SOURCE_ID={}",
        &source_id[..32]
    );

    napi_build::setup();
    Ok(())
}
