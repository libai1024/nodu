// SPDX-License-Identifier: MIT
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    let result = io::stdin().take(128001).read_to_string(&mut input).map_err(|_| "读取失败".to_string())
        .and_then(|_| if input.len() > 128000 { Err("请求过大".into()) } else { serde_json::from_str::<nodu_tutor::Request>(&input).map_err(|_| "请求格式无效".into()) })
        .and_then(|request| nodu_tutor::inspect(&request));
    match result {
        Ok(value) => println!("{}",serde_json::to_string(&value).unwrap()),
        Err(error) => { println!("{}",serde_json::json!({"error":error})); std::process::exit(1); }
    }
}
