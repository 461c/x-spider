use std::collections::HashMap;
use reqwest::Method;
use serde_json::Value;

#[derive(Default, serde::Serialize)]
pub struct Response {
  status: u16,
  headers: HashMap<String, Vec<String>>,
  body: Value,
}

#[tauri::command]
pub async fn network_fetch(
  method: String,
  url: String,
  body: String,
  enable_proxy: bool,
  proxy_url: String,
  response_type: String,
  headers: HashMap<String, String>,
) -> Result<Response, String> {
  let map_reqwest_err = |err: reqwest::Error| err.to_string();
  // Convert method string into Method
  let method: Method = match method.to_uppercase().as_str() {
    "GET" => Ok(Method::GET),
    "POST" => Ok(Method::POST),
    "PATCH" => Ok(Method::PATCH),
    "PUT" => Ok(Method::PUT),
    "DELETE" => Ok(Method::DELETE),
    "HEAD" => Ok(Method::HEAD),
    _ => Err("Invalid method".to_string()),
  }?;

  // Build client
  let client = {
    let mut b = reqwest::Client::builder();

    // Auto set proxy settings
    if enable_proxy {
      if proxy_url.len() == 0 {
        // Use system proxy, do nothing
      } else {
        // Use custom proxy url
        let proxy_http = reqwest::Proxy::http(proxy_url.clone()).or(Err("Failed to set proxy url".to_string()))?;
        let proxy_https = reqwest::Proxy::https(proxy_url.clone()).or(Err("Failed to set proxy url".to_string()))?;
        b = b.proxy(proxy_http).proxy(proxy_https);
      }
    } else {
      // No proxy
      b = b.no_proxy();
    }

    b.build().or(Err("Failed to build reqwest client".to_string()))
  }?;

  // Build request
  let request = {
    let mut req = client.request(method.clone(), url);
    for (k, v) in headers {
      req = req.header(k, v);
    }

    if !matches!(method.clone(), Method::GET) {
      req = req.body(body);
    }

    req
  };

  // Send request
  let response = request.send().await.map_err(map_reqwest_err)?;

  // Extract some info
  let status = response.status().as_u16();
  let resp_headers = {
    let reqwest_headers = response.headers();
    let mut h: HashMap<String, Vec<String>> = HashMap::with_capacity(reqwest_headers.len());

    for (k, v) in reqwest_headers {
      let v = v.to_str();
      if let Err(_) = v {
        continue;
      }

      let v = v.unwrap().to_string();
      h.entry(k.to_string()).and_modify(|arr: &mut Vec<String>| arr.push(v.clone()))
        .or_insert_with(|| vec![v]);
    }

    h
  };

  // Load response body
  let body: Value = {
    match response_type.as_str() {
      "json" => response.json().await.map_err(map_reqwest_err).map(|res| Value::Object(res)),
      "text" => response.text().await.map_err(map_reqwest_err).map(|res| Value::String(res)),
      "binary" => {
        let bytes = response.bytes().await.map_err(map_reqwest_err)?;
        serde_json::to_value(bytes.to_vec()).map_err(|err| err.to_string())
      },
      _ => Err("Unsupported response type".to_string())
    }
  }?;

  return Ok(Response {
    status,
    body,
    headers: resp_headers })
}

#[tauri::command]
pub async fn network_get_system_proxy_url() -> Result<HashMap<String, String>, ()> {
  let mut proxies = HashMap::new();
  for (scheme, vars) in [
    ("http", ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]),
    ("https", ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]),
  ] {
    if let Some(proxy) = vars
      .iter()
      .filter_map(|key| std::env::var(key).ok())
      .find_map(|value| proxy_address(&value))
    {
      proxies.insert(scheme.to_owned(), proxy);
    }
  }
  if proxies.is_empty() {
    proxies = windows_proxies();
  }
  Ok(proxies)
}

#[cfg(windows)]
fn windows_proxies() -> HashMap<String, String> {
  use winreg::{enums::HKEY_CURRENT_USER, RegKey};

  let current_user = RegKey::predef(HKEY_CURRENT_USER);
  let Ok(settings) = current_user
    .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
  else {
    return HashMap::new();
  };
  if settings.get_value::<u32, _>("ProxyEnable").ok() != Some(1) {
    return HashMap::new();
  }
  let Ok(server) = settings.get_value::<String, _>("ProxyServer") else {
    return HashMap::new();
  };
  if server.contains('=') {
    return server
      .split(';')
      .filter_map(|entry| entry.split_once('='))
      .filter_map(|(scheme, value)| {
        Some((scheme.trim().to_owned(), proxy_address(value)?))
      })
      .collect();
  }
  ["http", "https"]
    .into_iter()
    .filter_map(|scheme| Some((scheme.to_owned(), proxy_address(&server)?)))
    .collect()
}

#[cfg(not(windows))]
fn windows_proxies() -> HashMap<String, String> {
  HashMap::new()
}

fn proxy_address(value: &str) -> Option<String> {
  let value = value.trim();
  let url = if value.contains("://") {
    reqwest::Url::parse(value).ok()?
  } else {
    reqwest::Url::parse(&format!("http://{value}")).ok()?
  };
  if !matches!(url.scheme(), "http" | "https") {
    return None;
  }
  let host = url.host_str()?;
  let port = url.port_or_known_default()?;
  Some(format!("{host}:{port}"))
}
