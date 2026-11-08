//! Version 2 proxy chunks for large DSH → browser WebSocket text messages.
//!
//! The carrier retains its 64 KiB limit. Only endpoints interpret this payload;
//! one bounded text message is assembled per socket before delivery to DSH's UI.

/// Proxy payload version for text fragmentation (ordinary messages remain version 1).
pub const VERSION: u8 = 2;
/// Proxy message tag reserved for a WebSocket text fragment.
pub const TAG: u8 = 12;
/// Maximum complete text message; checked before allocating a receive buffer.
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// A fragment leaves room for the proxy and encrypted carrier overhead.
pub const MAX_CHUNK_BYTES: usize = crate::MAX_PAYLOAD_LEN as usize - 64;
const HEADER_LEN: usize = 24;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

/// An invalid chunk never includes its content in the diagnostic.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error(
    "invalid WebSocket text fragment bounds or format; reconnect with matching daemon and client versions"
)]
pub struct InvalidChunk;

/// One ordered fragment, with byte offsets so UTF-8 may straddle chunks.
pub struct TextChunk<'a> {
    /// Socket identifier, also used by version 1 `WsData`.
    pub id: u64,
    /// Full UTF-8 byte length, limited to [`MAX_TEXT_BYTES`].
    pub total: u32,
    /// Offset of this fragment in the complete message.
    pub offset: u32,
    /// Nonempty fragment bytes.
    pub bytes: &'a [u8],
}

impl std::fmt::Debug for TextChunk<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextChunk")
            .field("id", &self.id)
            .field("total", &self.total)
            .field("offset", &self.offset)
            .field("byte_length", &self.bytes.len())
            .finish()
    }
}

impl TextChunk<'_> {
    fn validate(&self) -> Result<(), InvalidChunk> {
        if self.id > MAX_SAFE_ID
            || self.total == 0
            || self.total as usize > MAX_TEXT_BYTES
            || self.bytes.is_empty()
            || self.bytes.len() > MAX_CHUNK_BYTES
            || u64::from(self.offset) + self.bytes.len() as u64 > u64::from(self.total)
        {
            return Err(InvalidChunk);
        }
        Ok(())
    }

    /// Encode one chunk without changing the carrier's frame limit.
    ///
    /// # Errors
    /// Rejects unsafe identifiers, empty chunks and inconsistent byte bounds.
    pub fn encode(&self) -> Result<Vec<u8>, InvalidChunk> {
        self.validate()?;
        let mut out = Vec::with_capacity(HEADER_LEN + self.bytes.len());
        out.extend_from_slice(&[b'P', b'X', VERSION, TAG]);
        out.extend_from_slice(&self.id.to_be_bytes());
        out.extend_from_slice(&self.total.to_be_bytes());
        out.extend_from_slice(&self.offset.to_be_bytes());
        out.extend_from_slice(&(self.bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(self.bytes);
        Ok(out)
    }
}

/// Decode one exact version 2 payload, rejecting trailing bytes as well as truncation.
///
/// # Errors
/// Rejects a different version/tag or any invalid length before returning the borrowed body.
pub fn decode(bytes: &[u8]) -> Result<TextChunk<'_>, InvalidChunk> {
    if bytes.len() < HEADER_LEN || bytes[..4] != [b'P', b'X', VERSION, TAG] {
        return Err(InvalidChunk);
    }
    let id = u64::from_be_bytes(bytes[4..12].try_into().map_err(|_| InvalidChunk)?);
    let total = u32::from_be_bytes(bytes[12..16].try_into().map_err(|_| InvalidChunk)?);
    let offset = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| InvalidChunk)?);
    let length = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| InvalidChunk)?) as usize;
    if length != bytes.len() - HEADER_LEN {
        return Err(InvalidChunk);
    }
    let chunk = TextChunk {
        id,
        total,
        offset,
        bytes: &bytes[HEADER_LEN..],
    };
    chunk.validate()?;
    Ok(chunk)
}
