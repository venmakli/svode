use std::fs::File;
use std::io::Read;
use std::path::Path;

// SQLite ignores invalid/incomplete WAL tails. Retention must preserve them
// instead of classifying only the readable main database as disposable.
// Format/checksum: https://sqlite.org/fileformat2.html#walformat
pub fn valid(main: &Path, path: &Path) -> std::io::Result<bool> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(true);
    }
    if len < 32 {
        return Ok(false);
    }
    let mut header = [0; 32];
    file.read_exact(&mut header)?;
    let magic = be(&header[0..4]);
    if !matches!(magic, 0x377f0682 | 0x377f0683) || be(&header[4..8]) != 3007000 {
        return Ok(false);
    }
    let page_size = be(&header[8..12]) as usize;
    if !(512..=65536).contains(&page_size) || !page_size.is_power_of_two() {
        return Ok(false);
    }
    if (len - 32) % (24 + page_size as u64) != 0 {
        return Ok(false);
    }
    let mut database = File::open(main)?;
    let mut database_header = [0; 100];
    if database.read_exact(&mut database_header).is_err()
        || &database_header[..16] != b"SQLite format 3\0"
        || database_header[18..20] != [2, 2]
    {
        return Ok(false);
    }
    let database_page_size = u16::from_be_bytes(database_header[16..18].try_into().unwrap());
    let database_page_size = if database_page_size == 1 {
        65536
    } else {
        usize::from(database_page_size)
    };
    if database_page_size != page_size || database.metadata()?.len() % page_size as u64 != 0 {
        return Ok(false);
    }
    let little = magic == 0x377f0682;
    let mut sum = checksum(&header[..24], little, (0, 0));
    if sum != (be(&header[24..28]), be(&header[28..32])) {
        return Ok(false);
    }
    let mut page = vec![0; page_size];
    let frames = (len - 32) / (24 + page_size as u64);
    let mut committed = frames == 0;
    for _ in 0..frames {
        let mut frame = [0; 24];
        file.read_exact(&mut frame)?;
        file.read_exact(&mut page)?;
        if be(&frame[..4]) == 0 || frame[8..16] != header[16..24] {
            return Ok(false);
        }
        sum = checksum(&frame[..8], little, sum);
        sum = checksum(&page, little, sum);
        if sum != (be(&frame[16..20]), be(&frame[20..24])) {
            return Ok(false);
        }
        committed = be(&frame[4..8]) != 0;
    }
    Ok(committed)
}

fn be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().unwrap())
}

fn checksum(bytes: &[u8], little: bool, (mut first, mut second): (u32, u32)) -> (u32, u32) {
    for pair in bytes.chunks_exact(8) {
        let word = |bytes: &[u8]| {
            if little {
                u32::from_le_bytes(bytes.try_into().unwrap())
            } else {
                be(bytes)
            }
        };
        first = first.wrapping_add(word(&pair[..4])).wrapping_add(second);
        second = second.wrapping_add(word(&pair[4..])).wrapping_add(first);
    }
    (first, second)
}
