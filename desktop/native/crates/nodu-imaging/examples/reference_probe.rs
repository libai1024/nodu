//! Emit a deterministic raster's histograms for independent reference checking.
fn main() {
    let rgba: Vec<u8> = (0..257u32)
        .flat_map(|i| {
            [
                (i % 256) as u8,
                ((i * 37) % 256) as u8,
                ((255 + 256 - i % 256) % 256) as u8,
                255,
            ]
        })
        .collect();
    let results: Vec<_> = (0..4)
        .map(|s| nodu_imaging::histogram(&rgba, 257, 1, &[3, 0, 251, 1], s).unwrap())
        .collect();
    println!("{}", serde_json::to_string(&results).unwrap());
}
