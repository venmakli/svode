use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

pub(crate) fn display_name_key(value: &str) -> String {
    let normalized = value.nfkc().case_fold().nfkc().collect::<String>();
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_key_is_locale_independent_and_compatibility_normalized() {
        for equivalent in [
            "  Quarterly\u{2003}Review  ",
            "quarterly review",
            "ＱＵＡＲＴＥＲＬＹ REVIEW",
        ] {
            assert_eq!(display_name_key(equivalent), "quarterly review");
        }
        assert_eq!(display_name_key("Straße"), display_name_key("STRASSE"));
        assert_eq!(display_name_key("oﬃce"), display_name_key("OFFICE"));
        assert_ne!(display_name_key("Resume"), display_name_key("Résumé"));
    }
}
