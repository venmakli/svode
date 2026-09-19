use std::sync::Arc;

use svode_core::index::IndexKey;
use svode_core::routines::{authority, local, store_state::RoutineStoreState};

#[tokio::test]
async fn core_opens_one_operational_store_and_preserves_it_across_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let owner = temporary.path().to_path_buf();
    let key = IndexKey::Root(owner.clone());
    let stores = Arc::new(RoutineStoreState::new());
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let stores = stores.clone();
        let key = key.clone();
        let owner = owner.clone();
        tasks.push(tokio::spawn(async move {
            stores.get_or_create(&key, &owner).await.unwrap()
        }));
    }
    let mut pools = Vec::new();
    for task in tasks {
        pools.push(task.await.unwrap());
    }
    assert!(authority::storage_was_created(&owner).unwrap());
    sqlx::query("INSERT INTO routine_owner_roots VALUES ('scope')")
        .execute(&pools[0])
        .await
        .unwrap();
    assert_eq!(
        stores.owner_paths(&key, &owner).await.unwrap(),
        vec!["scope".to_string()]
    );
    assert!(
        !local::read(&owner)
            .unwrap()
            .routines
            .unwrap()
            .automatic_authority
            .contains_key("scope")
    );

    stores.close_project(&owner).await;
    assert!(pools.iter().all(sqlx::SqlitePool::is_closed));
    let reopened = stores.get_or_create(&key, &owner).await.unwrap();
    assert_eq!(
        stores.owner_paths(&key, &owner).await.unwrap(),
        vec!["scope".to_string()]
    );
    assert!(!reopened.is_closed());
    stores.close_key(&key).await;
}
