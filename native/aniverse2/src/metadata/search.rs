use super::cards;
use icu_normalizer::ComposingNormalizer;
use serde_json::Value;
use std::collections::HashMap;

fn normalize(text: &str) -> String {
    ComposingNormalizer::new_nfkc()
        .normalize(text)
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|letter| !matches!(letter, '\'' | '\u{2019}' | '`'))
        .fold(String::new(), |mut result, letter| {
            if letter.is_alphanumeric() {
                result.push(letter);
            } else if letter == '&' {
                result.push_str(" and ");
            } else if !result.ends_with(' ') {
                result.push(' ');
            }
            result
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn broader(query: &str) -> Option<String> {
    let normalized = normalize(query);
    let mut words = normalized.split_whitespace().filter(|word| {
        word.encode_utf16().count() >= 3 && !matches!(*word, "the" | "and" | "season" | "part")
    });
    let first = words.next()?;
    words.next().map(|_| first.to_owned())
}

fn word_score(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let left: Vec<_> = a.encode_utf16().collect();
    let right: Vec<_> = b.encode_utf16().collect();
    if left.len() >= 3 && right.starts_with(&left) {
        return 0.95;
    }
    if left.len() < 4 || right.len() < 4 || left.len().abs_diff(right.len()) > 2 {
        return 0.0;
    }
    let mut row: Vec<_> = (0..=right.len()).collect();
    for (index, letter) in left.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = index + 1;
        for (position, candidate) in right.iter().enumerate() {
            let previous = row[position + 1];
            row[position + 1] = (row[position] + 1)
                .min(previous + 1)
                .min(diagonal + usize::from(letter != candidate));
            diagonal = previous;
        }
    }
    let length = left.len().max(right.len());
    let distance = row[right.len()];
    if distance <= 1.max(length / 5) {
        1.0 - distance as f64 / length as f64
    } else {
        0.0
    }
}

pub(crate) fn discovery_score<'a>(query: &str, aliases: impl IntoIterator<Item = &'a str>) -> f64 {
    score(&normalize(query), aliases)
}

fn score<'a>(query: &str, aliases: impl IntoIterator<Item = &'a str>) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let words: Vec<_> = query.split_whitespace().collect();
    aliases
        .into_iter()
        .map(normalize)
        .map(|alias| {
            if alias == query {
                return 2.0;
            }
            if alias.contains(query) {
                return 1.5;
            }
            words
                .iter()
                .map(|word| {
                    alias
                        .split_whitespace()
                        .map(|candidate| word_score(word, candidate))
                        .fold(0.0, f64::max)
                })
                .sum::<f64>()
                / words.len() as f64
        })
        .fold(0.0, f64::max)
}

pub(super) fn rank(term: &str, primary: Vec<Value>, nearby: Vec<Value>, adult: bool) -> Vec<Value> {
    let mut order = Vec::new();
    let mut entries = HashMap::new();
    for raw in primary
        .into_iter()
        .chain(nearby)
        .filter(|raw| cards::visible(raw, adult))
    {
        let Some(id) = raw["id"].as_u64() else {
            continue;
        };
        if entries.insert(id, raw).is_none() {
            order.push(id);
        }
    }
    let query = normalize(term);
    let mut scores: Vec<_> = order
        .into_iter()
        .filter_map(|id| entries.remove(&id))
        .map(|raw| {
            let aliases = ["romaji", "english", "native", "userPreferred"]
                .into_iter()
                .map(|key| &raw["title"][key])
                .chain(raw["synonyms"].as_array().into_iter().flatten())
                .filter_map(Value::as_str);
            (score(&query, aliases), raw)
        })
        .collect();
    scores.sort_by(|left, right| right.0.total_cmp(&left.0));
    scores
        .into_iter()
        .take(24)
        .filter_map(|(_, raw)| cards::card(&raw))
        .collect()
}
