fn main() {
    println!("cargo:rerun-if-changed=../../schemas/proto/editor/v1/editor.proto");
    prost_build::Config::new()
        // Emit `BTreeMap` for every `map<…>` field. Ordered keys make the wire
        // encoding of forward-compatibility `extensions` maps deterministic, so a
        // re-encode is byte-identical and Canonical Hash inputs are reproducible
        // (ADR 0023). `HashMap`'s per-process iteration order would break both.
        .btree_map(["."])
        .compile_protos(
            &["../../schemas/proto/editor/v1/editor.proto"],
            &["../../schemas/proto"],
        )
        .expect("Protocol Buffers compiler must generate the protocol crate");
}
