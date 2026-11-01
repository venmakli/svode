//! Version messages in the author's interface language (Stage 11 1.G): the
//! facts of a group glued by fixed rules into a summary header and a body
//! listing every fact. No model, network or tokens.

use super::facts::{ChangeFact, GroupFacts, Place, Sensitive};

/// The interface languages of Svode; a message is written in the author's
/// at the moment of the commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MessageLanguage {
    #[default]
    En,
    Ru,
}

impl MessageLanguage {
    /// The language of an interface locale tag; English for any other.
    pub fn from_locale(locale: &str) -> Self {
        if locale.eq_ignore_ascii_case("ru") || locale.to_ascii_lowercase().starts_with("ru-") {
            Self::Ru
        } else {
            Self::En
        }
    }
}

/// A commit message: the summary line and the full fact list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionMessage {
    pub header: String,
    pub body: Vec<String>,
}

impl VersionMessage {
    /// The text `git commit -m` takes.
    pub fn text(&self) -> String {
        if self.body.is_empty() {
            return self.header.clone();
        }
        let body = self
            .body
            .iter()
            .map(|line| format!("- {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n\n{body}", self.header)
    }
}

/// Facts sharing more places than this make a general message.
const MIXED_PLACES: usize = 2;
/// Records a header names one by one before it counts them.
const LISTED_RECORDS: usize = 3;

pub fn compose(group: &GroupFacts, language: MessageLanguage) -> VersionMessage {
    let t = Templates(language);
    if let Some(sensitive) = group.sensitive {
        return VersionMessage {
            header: t.sensitive(sensitive),
            body: Vec::new(),
        };
    }
    let facts = &group.facts;
    let tail = |header: String| match group.links {
        0 => header,
        links => format!("{header}, {}", t.links(links)),
    };
    if facts.is_empty() {
        return VersionMessage {
            header: tail(t.general(group)),
            body: Vec::new(),
        };
    }
    let body = || {
        facts
            .iter()
            .map(|placed| {
                t.with_place(
                    &placed.place,
                    placed.fact.self_placed(),
                    &t.fact(&placed.fact, true),
                )
            })
            .collect::<Vec<_>>()
    };
    if facts.len() == 1 {
        let placed = &facts[0];
        return VersionMessage {
            header: tail(t.with_place(
                &placed.place,
                placed.fact.self_placed(),
                &t.fact(&placed.fact, false),
            )),
            body: Vec::new(),
        };
    }
    let mut places = Vec::<&Place>::new();
    for placed in facts {
        if !places.contains(&&placed.place) {
            places.push(&placed.place);
        }
    }
    if places.len() > MIXED_PLACES {
        return VersionMessage {
            header: t.mixed(
                // A repository root without a name does not lead.
                places
                    .iter()
                    .copied()
                    .find(|place| **place != Place::None)
                    .unwrap_or(places[0]),
                places.len() - 1,
                group,
            ),
            body: body(),
        };
    }
    let header = if places.len() == 1
        && let Some(counted) = t.counted(places[0], facts.iter().map(|placed| &placed.fact))
    {
        counted
    } else {
        let main = main_fact(facts);
        let placed = &facts[main];
        format!(
            "{}{}",
            t.with_place(
                &placed.place,
                placed.fact.self_placed(),
                &t.fact(&placed.fact, false)
            ),
            t.more(facts.len() - 1)
        )
    };
    VersionMessage {
        header: tail(header),
        body: body(),
    }
}

/// The fact a header of different facts leads with: an operation on a
/// Page, then schema, fields, the most changed section and attachments.
fn main_fact(facts: &[super::facts::PlacedFact]) -> usize {
    let rank = |fact: &ChangeFact| match fact {
        ChangeFact::PageCreated { .. }
        | ChangeFact::PageDeleted { .. }
        | ChangeFact::PageMoved { .. }
        | ChangeFact::PageRenamed { .. } => (0, 0),
        ChangeFact::SchemaFieldAdded { .. }
        | ChangeFact::SchemaFieldRemoved { .. }
        | ChangeFact::SchemaFieldRenamed { .. }
        | ChangeFact::ViewChanged { .. } => (1, 0),
        ChangeFact::FieldChanged { .. } => (2, 0),
        ChangeFact::SectionChanged { share, .. } => (3, 100 - u16::from(*share)),
        ChangeFact::AttachmentAdded { .. } | ChangeFact::AttachmentRemoved { .. } => (4, 0),
    };
    (0..facts.len())
        .min_by_key(|index| rank(&facts[*index].fact))
        .unwrap_or(0)
}

/// Russian noun form for a count: one, few (2–4) or many.
fn ru_form<'a>(count: usize, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    let (tens, units) = (count % 100, count % 10);
    if (11..=14).contains(&tens) {
        many
    } else if units == 1 {
        one
    } else if (2..=4).contains(&units) {
        few
    } else {
        many
    }
}

/// Russian genitive after a count in a noun phrase: singular after 1, 21, …
fn ru_genitive<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count % 10 == 1 && count % 100 != 11 {
        singular
    } else {
        plural
    }
}

fn en_plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 { one } else { many }
}

struct Templates(MessageLanguage);

impl Templates {
    fn ru(&self) -> bool {
        self.0 == MessageLanguage::Ru
    }

    fn quote(&self, text: &str) -> String {
        if self.ru() {
            format!("«{text}»")
        } else {
            format!("“{text}”")
        }
    }

    fn value(&self, value: &Option<String>) -> String {
        match value {
            Some(value) => self.quote(value),
            None if self.ru() => "пусто".into(),
            None => "empty".into(),
        }
    }

    fn place(&self, place: &Place) -> Option<String> {
        match place {
            Place::None => None,
            Place::Named(name) => Some(name.clone()),
            Place::Collection(name) if self.ru() => Some(format!("Коллекция {}", self.quote(name))),
            Place::Collection(name) => Some(format!("Collection {}", self.quote(name))),
        }
    }

    /// `text` after its place, or as its own sentence for a fact that names
    /// its Page itself.
    fn with_place(&self, place: &Place, self_placed: bool, text: &str) -> String {
        match self.place(place).filter(|_| !self_placed) {
            Some(place) => format!("{place}: {text}"),
            None => capitalized(text),
        }
    }

    /// One fact; `full` adds the old value of a field and the share of a
    /// section.
    fn fact(&self, fact: &ChangeFact, full: bool) -> String {
        let q = |text: &str| self.quote(text);
        let ru = self.ru();
        match fact {
            ChangeFact::PageCreated { title } if ru => format!("создана {}", q(title)),
            ChangeFact::PageCreated { title } => format!("create {}", q(title)),
            ChangeFact::PageDeleted { title } if ru => format!("удалена {}", q(title)),
            ChangeFact::PageDeleted { title } => format!("delete {}", q(title)),
            ChangeFact::PageMoved {
                title,
                folder: Some(folder),
            } if ru => format!("перемещена {} в {}", q(title), q(folder)),
            ChangeFact::PageMoved {
                title,
                folder: Some(folder),
            } => format!("move {} to {}", q(title), q(folder)),
            ChangeFact::PageMoved {
                title,
                folder: None,
            } if ru => format!("перемещена {}", q(title)),
            ChangeFact::PageMoved {
                title,
                folder: None,
            } => format!("move {}", q(title)),
            ChangeFact::PageRenamed { from, to } if ru => {
                format!("переименована {} в {}", q(from), q(to))
            }
            ChangeFact::PageRenamed { from, to } => format!("rename {} to {}", q(from), q(to)),
            ChangeFact::FieldChanged {
                record,
                field,
                from,
                to,
            } => {
                // The old value is part of the fact, in a header too.
                if from.is_some() {
                    format!(
                        "{record}: {}: {} → {}",
                        q(field),
                        self.value(from),
                        self.value(to)
                    )
                } else {
                    format!("{record}: {} → {}", q(field), self.value(to))
                }
            }
            ChangeFact::SectionChanged { heading, share, .. } => {
                let text = match heading {
                    Some(heading) if ru => format!("правка раздела {}", q(heading)),
                    Some(heading) => format!("edit section {}", q(heading)),
                    None if ru => "правка текста".into(),
                    None => "edit text".into(),
                };
                match (full, ru) {
                    (false, _) => text,
                    (true, true) => format!("{text} ({share}% строк)"),
                    (true, false) => format!("{text} ({share}% of lines)"),
                }
            }
            ChangeFact::SchemaFieldAdded { field } if ru => format!("новое поле {}", q(field)),
            ChangeFact::SchemaFieldAdded { field } => format!("new field {}", q(field)),
            ChangeFact::SchemaFieldRemoved { field } if ru => format!("удалено поле {}", q(field)),
            ChangeFact::SchemaFieldRemoved { field } => format!("remove field {}", q(field)),
            ChangeFact::SchemaFieldRenamed { from, to } if ru => {
                format!("поле {} переименовано в {}", q(from), q(to))
            }
            ChangeFact::SchemaFieldRenamed { from, to } => {
                format!("rename field {} to {}", q(from), q(to))
            }
            ChangeFact::ViewChanged { view } if ru => format!("изменён вид {}", q(view)),
            ChangeFact::ViewChanged { view } => format!("update view {}", q(view)),
            ChangeFact::AttachmentAdded { name } if ru => format!("добавлено вложение {}", q(name)),
            ChangeFact::AttachmentAdded { name } => format!("add attachment {}", q(name)),
            ChangeFact::AttachmentRemoved { name } if ru => format!("удалено вложение {}", q(name)),
            ChangeFact::AttachmentRemoved { name } => format!("remove attachment {}", q(name)),
        }
    }

    /// The header of facts of one kind in one place, or `None` when they
    /// are not alike.
    fn counted<'a>(
        &self,
        place: &Place,
        facts: impl Iterator<Item = &'a ChangeFact>,
    ) -> Option<String> {
        let facts = facts.collect::<Vec<_>>();
        let n = facts.len();
        let ru = self.ru();
        let all = |test: fn(&ChangeFact) -> bool| facts.iter().all(|fact| test(fact));
        let names = |name: fn(&ChangeFact) -> Option<&String>| -> Vec<String> {
            facts
                .iter()
                .filter_map(|fact| name(fact).map(|name| self.quote(name)))
                .collect()
        };
        let text = if all(|fact| matches!(fact, ChangeFact::FieldChanged { .. })) {
            let fields = facts
                .iter()
                .filter_map(|fact| match fact {
                    ChangeFact::FieldChanged {
                        record, field, to, ..
                    } => Some((record, field, to)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let (_, field, to) = fields[0];
            let mut records = Vec::<&String>::new();
            for (record, _, _) in &fields {
                if !records.contains(record) {
                    records.push(record);
                }
            }
            let records_n = records.len();
            if fields.iter().all(|(_, f, t)| *f == field && *t == to) && records_n == n {
                if n <= LISTED_RECORDS {
                    let listed = records
                        .iter()
                        .map(|record| record.to_string())
                        .collect::<Vec<_>>();
                    format!("{} → {}", self.list(&listed), self.value(to))
                } else if ru {
                    format!(
                        "{} → {} у {n} {}",
                        self.quote(field),
                        self.value(to),
                        ru_genitive(n, "записи", "записей")
                    )
                } else {
                    format!("{} → {} in {n} entries", self.quote(field), self.value(to))
                }
            } else if fields.iter().all(|(_, f, _)| *f == field) {
                if ru {
                    format!(
                        "{} изменено у {records_n} {}",
                        self.quote(field),
                        ru_genitive(records_n, "записи", "записей")
                    )
                } else {
                    format!(
                        "{} changed in {records_n} {}",
                        self.quote(field),
                        en_plural(records_n, "entry", "entries")
                    )
                }
            } else if ru {
                format!(
                    "правки полей у {records_n} {}",
                    ru_genitive(records_n, "записи", "записей")
                )
            } else {
                format!(
                    "edit fields in {records_n} {}",
                    en_plural(records_n, "entry", "entries")
                )
            }
        } else if all(|fact| matches!(fact, ChangeFact::SectionChanged { .. })) {
            let headings = names(|fact| match fact {
                ChangeFact::SectionChanged { heading, .. } => heading.as_ref(),
                _ => None,
            });
            if headings.len() == n && n <= LISTED_RECORDS {
                if ru {
                    format!("правка разделов {}", self.list(&headings))
                } else {
                    format!("edit sections {}", self.list(&headings))
                }
            } else if ru {
                format!("правка {n} {}", ru_genitive(n, "раздела", "разделов"))
            } else {
                format!("edit {n} sections")
            }
        } else if all(|fact| matches!(fact, ChangeFact::AttachmentAdded { .. })) {
            if ru {
                format!(
                    "{} {n} {}",
                    ru_form(n, "добавлено", "добавлены", "добавлено"),
                    ru_form(n, "вложение", "вложения", "вложений")
                )
            } else {
                format!("add {n} attachments")
            }
        } else if all(|fact| matches!(fact, ChangeFact::AttachmentRemoved { .. })) {
            if ru {
                format!(
                    "{} {n} {}",
                    ru_form(n, "удалено", "удалены", "удалено"),
                    ru_form(n, "вложение", "вложения", "вложений")
                )
            } else {
                format!("remove {n} attachments")
            }
        } else if all(|fact| matches!(fact, ChangeFact::SchemaFieldAdded { .. })) {
            let fields = names(|fact| match fact {
                ChangeFact::SchemaFieldAdded { field } => Some(field),
                _ => None,
            });
            match (n <= LISTED_RECORDS, ru) {
                (true, true) => format!("новые поля {}", self.list(&fields)),
                (true, false) => format!("new fields {}", self.list(&fields)),
                (false, true) => format!("{n} новых полей"),
                (false, false) => format!("{n} new fields"),
            }
        } else if all(|fact| matches!(fact, ChangeFact::ViewChanged { .. })) {
            let views = names(|fact| match fact {
                ChangeFact::ViewChanged { view } => Some(view),
                _ => None,
            });
            match (n <= LISTED_RECORDS, ru) {
                (true, true) => format!("изменены виды {}", self.list(&views)),
                (true, false) => format!("update views {}", self.list(&views)),
                (false, true) => format!("изменено {n} видов"),
                (false, false) => format!("update {n} views"),
            }
        } else {
            let (ru_noun, en_verb) = if all(|fact| matches!(fact, ChangeFact::PageCreated { .. })) {
                ("создание", "create")
            } else if all(|fact| matches!(fact, ChangeFact::PageDeleted { .. })) {
                ("удаление", "delete")
            } else if all(|fact| matches!(fact, ChangeFact::PageMoved { .. })) {
                ("перемещение", "move")
            } else if all(|fact| matches!(fact, ChangeFact::PageRenamed { .. })) {
                ("переименование", "rename")
            } else {
                return None;
            };
            if ru {
                format!("{ru_noun} {n} {}", ru_genitive(n, "страницы", "страниц"))
            } else {
                format!("{en_verb} {n} pages")
            }
        };
        Some(self.with_place(place, false, &text))
    }

    /// "A, B и C" / "A, B and C".
    fn list(&self, items: &[String]) -> String {
        let conjunction = if self.ru() { " и " } else { " and " };
        match items {
            [] => String::new(),
            [one] => one.clone(),
            [rest @ .., last] => format!("{}{conjunction}{last}", rest.join(", ")),
        }
    }

    fn more(&self, count: usize) -> String {
        if self.ru() {
            format!(
                " и ещё {count} {}",
                ru_form(count, "изменение", "изменения", "изменений")
            )
        } else {
            format!(
                " and {count} more {}",
                en_plural(count, "change", "changes")
            )
        }
    }

    fn links(&self, count: usize) -> String {
        if self.ru() {
            format!(
                "{} {count} {}",
                ru_form(count, "обновлена", "обновлены", "обновлено"),
                ru_form(count, "ссылка", "ссылки", "ссылок")
            )
        } else {
            format!("update {count} {}", en_plural(count, "link", "links"))
        }
    }

    /// "<place>: edit N pages" — the message of a group without facts.
    fn general(&self, group: &GroupFacts) -> String {
        let ru = self.ru();
        let pages = group.pages;
        let files = group.files;
        let text = match group.general {
            super::facts::General::Page if ru => "правка страницы".to_string(),
            super::facts::General::Page => "edit page".to_string(),
            super::facts::General::Schema if ru => "правка схемы".to_string(),
            super::facts::General::Schema => "edit schema".to_string(),
            super::facts::General::Order if ru => "изменён порядок".to_string(),
            super::facts::General::Order => "reorder".to_string(),
            super::facts::General::Settings if ru => "настройки".to_string(),
            super::facts::General::Settings => "settings".to_string(),
            super::facts::General::Spaces if ru => "пространства и указатели".to_string(),
            super::facts::General::Spaces => "spaces and pointers".to_string(),
            super::facts::General::Entries if ru => {
                format!("правки {pages} {}", ru_genitive(pages, "записи", "записей"))
            }
            super::facts::General::Entries => {
                format!("edit {pages} {}", en_plural(pages, "entry", "entries"))
            }
            super::facts::General::Files => self.counted_files(pages, files),
        };
        self.with_place(&group.place, false, &text)
    }

    fn counted_files(&self, pages: usize, files: usize) -> String {
        match (pages == files, self.ru()) {
            (true, true) => format!(
                "правки {pages} {}",
                ru_genitive(pages, "страницы", "страниц")
            ),
            (true, false) => format!("edit {pages} {}", en_plural(pages, "page", "pages")),
            (false, true) => format!(
                "изменения {files} {}",
                ru_genitive(files, "файла", "файлов")
            ),
            (false, false) => format!("change {files} {}", en_plural(files, "file", "files")),
        }
    }

    /// "<first place> and N more sections: edit M pages".
    fn mixed(&self, first: &Place, others: usize, group: &GroupFacts) -> String {
        let counted = self.counted_files(group.pages, group.files);
        let Some(name) = self.place(first) else {
            return capitalized(&counted);
        };
        if self.ru() {
            format!(
                "{name} и ещё {others} {}: {counted}",
                ru_form(others, "раздел", "раздела", "разделов")
            )
        } else {
            format!(
                "{name} and {others} more {}: {counted}",
                en_plural(others, "section", "sections")
            )
        }
    }

    fn sensitive(&self, sensitive: Sensitive) -> String {
        let ru = self.ru();
        match sensitive {
            Sensitive::Created if ru => "Создана запись коллекции".into(),
            Sensitive::Created => "Create collection entry".into(),
            Sensitive::Deleted if ru => "Удалена запись коллекции".into(),
            Sensitive::Deleted => "Delete collection entry".into(),
            Sensitive::Renamed if ru => "Переименована запись коллекции".into(),
            Sensitive::Renamed => "Rename collection entry".into(),
            Sensitive::Moved if ru => "Перемещена запись коллекции".into(),
            Sensitive::Moved => "Move collection entry".into(),
            Sensitive::Schema if ru => "Изменена схема коллекции".into(),
            Sensitive::Schema => "Update collection schema".into(),
            Sensitive::Entries(1) if ru => "Правка записи коллекции".into(),
            Sensitive::Entries(1) => "Update collection entry".into(),
            Sensitive::Entries(n) if ru => format!(
                "Правки {n} {} коллекции",
                ru_genitive(n, "записи", "записей")
            ),
            Sensitive::Entries(n) => format!("Update {n} collection entries"),
        }
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
