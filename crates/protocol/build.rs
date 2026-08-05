fn main() {
    println!("cargo:rerun-if-changed=../../schemas/proto/editor/v1/editor.proto");
    prost_build::Config::new()
        .compile_protos(
            &["../../schemas/proto/editor/v1/editor.proto"],
            &["../../schemas/proto"],
        )
        .expect("Protocol Buffers compiler must generate the protocol crate");
}
