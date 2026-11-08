//! The same normative payload vectors are consumed by the TypeScript endpoint.
use dr_dsh_proto::proxy_ws::{TextChunk, decode};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    proxy_text_chunks: Vec<Vector>,
    proxy_text_rejections: Vec<Rejected>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    hex: String,
    id: u64,
    total: u32,
    offset: u32,
    payload_hex: String,
}
#[derive(Deserialize)]
struct Rejected {
    name: String,
    hex: String,
}
fn unhex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    (0..value.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&value[i..i + 2], 16)?))
        .collect()
}

#[test]
fn text_fragment_vectors_match_the_browser() -> Result<(), Box<dyn std::error::Error>> {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../packages/protocol/conformance/vectors.json"
    ))?;
    for vector in corpus.proxy_text_chunks {
        let bytes = unhex(&vector.hex)?;
        let body = unhex(&vector.payload_hex)?;
        let chunk = decode(&bytes)?;
        assert_eq!(
            (chunk.id, chunk.total, chunk.offset, chunk.bytes),
            (vector.id, vector.total, vector.offset, body.as_slice()),
            "{}",
            vector.name
        );
        assert_eq!(
            TextChunk {
                id: vector.id,
                total: vector.total,
                offset: vector.offset,
                bytes: &body
            }
            .encode()?,
            bytes,
            "{}",
            vector.name
        );
        assert!(!format!("{chunk:?}").contains(&vector.payload_hex));
    }
    for rejected in corpus.proxy_text_rejections {
        assert!(decode(&unhex(&rejected.hex)?).is_err(), "{}", rejected.name);
    }
    Ok(())
}
