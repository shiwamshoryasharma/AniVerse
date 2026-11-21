use super::{backup, valid_id, FILE, FOLDER, FOLDER_MIME};
use crate::{
    integrations::{bounded, network, response_json, url_query, Service},
    RpcError,
};
use reqwest::{header, Method};
use serde_json::{json, Value};

const BASE: &str = "https://www.googleapis.com/drive/v3/files";
const FIELDS: &str = "id,name,mimeType,capabilities(canEdit)";

pub(super) struct Client<'a> {
    pub(super) service: &'a Service,
    pub(super) token: &'a str,
}

impl Client<'_> {
    async fn list(&self, query: &str) -> Result<Vec<Value>, RpcError> {
        let fields = format!("files({FIELDS}),nextPageToken");
        let url = url_query(
            BASE,
            &[
                ("q", query),
                ("fields", &fields),
                ("pageSize", "100"),
                ("spaces", "drive"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ],
        )?;
        let response = self
            .service
            .send(self.service.client.get(url).bearer_auth(self.token))
            .await?;
        let data = response_json(response, 256_000).await?;
        let files = data["files"]
            .as_array()
            .filter(|files| files.len() <= 100)
            .ok_or_else(network)?;
        if !data["nextPageToken"].is_null() || !files.iter().all(valid_file) {
            return Err(RpcError::new(
                "unavailable",
                "Drive returned too many or invalid matching items. Choose the exact sync folder.",
            ));
        }
        Ok(files.clone())
    }

    pub(super) async fn folder(&self, id: Option<&str>, create: bool) -> Result<Value, RpcError> {
        if let Some(id) = id.filter(|id| valid_id(id)) {
            let url = url_query(
                &format!("{BASE}/{id}"),
                &[("fields", FIELDS), ("supportsAllDrives", "true")],
            )?;
            let response = self
                .service
                .send(self.service.client.get(url).bearer_auth(self.token))
                .await?;
            let folder = response_json(response, 32_000).await?;
            return valid_folder(folder);
        }
        let list = self
            .list(&format!(
                "trashed=false and 'me' in owners and mimeType='{FOLDER_MIME}' and name='{FOLDER}'"
            ))
            .await?;
        if let Some(folder) = unique(
            list,
            "Multiple AniVerse Sync folders exist. Choose the exact folder link.",
        )? {
            return valid_folder(folder);
        }
        if !create {
            return Err(RpcError::new(
                "not-found",
                "No AniVerse Sync folder exists. Export first or choose a shared folder.",
            ));
        }
        let url = url_query(BASE, &[("fields", FIELDS), ("supportsAllDrives", "true")])?;
        let response = self
            .service
            .send(
                self.service
                    .client
                    .post(url)
                    .bearer_auth(self.token)
                    .json(&json!({"name":FOLDER, "mimeType":FOLDER_MIME})),
            )
            .await?;
        valid_folder(response_json(response, 32_000).await?)
    }

    async fn file(&self, folder: &str) -> Result<Option<Value>, RpcError> {
        if !valid_id(folder) {
            return Err(network());
        }
        let list = self
            .list(&format!(
                "trashed=false and '{folder}' in parents and name='{FILE}'"
            ))
            .await?;
        let file = unique(
            list,
            "More than one file uses the fixed backup filename. Resolve duplicates in Drive.",
        )?;
        if file
            .as_ref()
            .is_some_and(|file| file["name"] != FILE || file["mimeType"] != "application/json")
        {
            return Err(RpcError::new(
                "unavailable",
                "The fixed backup filename is occupied by a different file type.",
            ));
        }
        Ok(file)
    }

    async fn read(&self, file: &Value) -> Result<(Value, Option<header::HeaderValue>), RpcError> {
        let id = resource_id(file).ok_or_else(network)?;
        let url = url_query(
            &format!("{BASE}/{id}"),
            &[("alt", "media"), ("supportsAllDrives", "true")],
        )?;
        let response = self
            .service
            .send(self.service.client.get(url).bearer_auth(self.token))
            .await?;
        let tag = response.headers().get(header::ETAG).cloned();
        let data = response_json(response, backup::LIMIT).await?;
        Ok((backup::validate(data)?, tag))
    }

    pub(super) async fn download(&self, folder: &str) -> Result<Value, RpcError> {
        let file = self.file(folder).await?.ok_or_else(|| {
            RpcError::new("not-found", "No AniVerse backup exists in this folder.")
        })?;
        self.read(&file).await.map(|(data, _)| data)
    }

    pub(super) async fn upload(
        &self,
        folder: &str,
        backup: Vec<u8>,
        before_send: impl FnOnce() -> Result<(), RpcError>,
    ) -> Result<(), RpcError> {
        let file = self.file(folder).await?;
        if file
            .as_ref()
            .is_some_and(|file| file["capabilities"]["canEdit"] == false)
        {
            return Err(RpcError::new(
                "unauthorised",
                "This Drive backup is read-only.",
            ));
        }
        let tag = match file.as_ref() {
            Some(existing) => self.read(existing).await?.1,
            None => None,
        };
        let id = file.as_ref().and_then(resource_id);
        let fresh = id.is_none();
        let base = "https://www.googleapis.com/upload/drive/v3/files";
        let target = if let Some(id) = id {
            format!("{base}/{id}")
        } else {
            base.to_owned()
        };
        let url = url_query(
            &target,
            &[("uploadType", "multipart"), ("supportsAllDrives", "true")],
        )?;
        let metadata = if fresh {
            json!({"name":FILE, "parents":[folder], "mimeType":"application/json", "appProperties":{"aniverseSchema":"1"}})
        } else {
            json!({"name":FILE})
        };
        let boundary = format!("aniverse_{}", uuid::Uuid::new_v4().simple());
        let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n").into_bytes();
        body.extend(backup);
        body.extend(format!("\r\n--{boundary}--").as_bytes());
        let mut request = self
            .service
            .client
            .request(if fresh { Method::POST } else { Method::PATCH }, url)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/related; boundary={boundary}"),
            )
            .bearer_auth(self.token)
            .body(body);
        if let Some(tag) = tag {
            request = request.header(header::IF_MATCH, tag);
        }
        before_send()?;
        let response = self.service.send(request).await?;
        bounded(response, 32_000).await?;
        Ok(())
    }
}

fn unique(mut rows: Vec<Value>, message: &'static str) -> Result<Option<Value>, RpcError> {
    if rows.len() > 1 {
        return Err(RpcError::new("unavailable", message));
    }
    Ok(rows.pop())
}

pub(super) fn resource_id(file: &Value) -> Option<&str> {
    file["id"].as_str().filter(|id| valid_id(id))
}

fn valid_file(file: &Value) -> bool {
    resource_id(file).is_some()
        && file["name"].as_str().is_some_and(|name| name.len() <= 500)
        && file["mimeType"]
            .as_str()
            .is_some_and(|mime| mime.len() <= 200)
}

fn valid_folder(folder: Value) -> Result<Value, RpcError> {
    if valid_file(&folder) && folder["name"] == FOLDER && folder["mimeType"] == FOLDER_MIME {
        return Ok(folder);
    }
    Err(RpcError::new(
        "invalid-input",
        "Choose a folder named AniVerse Sync.",
    ))
}
