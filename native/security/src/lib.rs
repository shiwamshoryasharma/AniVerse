use percent_encoding::percent_decode_str;
use serde::Deserialize;
use std::{cell::RefCell, net::{IpAddr, Ipv4Addr}};
use url::{Host, Url};

const LIMIT: usize = 16384;
thread_local! { static INPUT: RefCell<[u8; LIMIT]> = const { RefCell::new([0; LIMIT]) }; }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request<'a> {
    context: &'a str,
    url: &'a str,
    #[serde(default)]
    source: &'a str,
    #[serde(default)]
    allowed_origins: Vec<&'a str>,
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a,b,c,_] = ip.octets();
    !(a == 0 || a == 10 || a == 127 || a >= 224 ||
      (a == 100 && (64..=127).contains(&b)) ||
      (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b)) ||
      (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)))) ||
      (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
      (a == 203 && b == 0 && c == 113))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() { return public_v4(v4); }
            let s = ip.segments();
            // Public global unicast only; exclude documentation and transition ranges.
            s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && s[1] == 0x0db8) &&
                s[0] != 0x2002 && !(s[0] == 0x2001 && s[1] == 0)
        }
    }
}
fn private_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => !public_v4(ip),
        Some(Host::Ipv6(ip)) => !public_ip(IpAddr::V6(ip)),
        Some(Host::Domain(host)) => {
            let host=host.trim_end_matches('.');
            host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") ||
                !host.contains('.')
        },
        None => true,
    }
}
fn parse(value: &str) -> Result<Url,u32> {
    if value.len()>4096 || value.trim()!=value || value.bytes().any(|b| b < 32 || b == 127 || b == b'\\') { return Err(1); }
    let url=Url::parse(value).map_err(|_|1u32)?;
    if !url.username().is_empty() || url.password().is_some() { return Err(3); }
    Ok(url)
}
fn decide(req: Request<'_>) -> u32 {
    if req.allowed_origins.len()>16 { return 1; }
    if req.context=="address" {
        return if req.url.parse::<IpAddr>().map(public_ip).unwrap_or(false) {0} else {4};
    }
    let url=match parse(req.url) {Ok(url)=>url,Err(code)=>return code};
    if req.context=="asset" {
        if url.scheme()!="app" || url.host_str()!=Some("aniverse") || url.port().is_some() {return 5;}
        let path=match percent_decode_str(url.path()).decode_utf8(){Ok(path)=>path,Err(_)=>return 6};
        return if path.chars().any(|c|c.is_control()||c=='\\'||c==':'||c=='%') ||
            path.split('/').any(|part|part==".."||part=="."){6}else{0};
    }
    if !matches!(req.context,"network"|"navigate"|"external") {return 1;}
    let websocket=req.context=="network"&&matches!(url.scheme(),"ws"|"wss");
    if !matches!(url.scheme(),"http"|"https")&&!websocket {return 2;}
    let source=parse(req.source).ok().filter(|s|matches!(s.scheme(),"http"|"https"));
    let same_origin=source.as_ref().is_some_and(|s|s.origin()==url.origin());
    // Explicitly configured local sources do not authorize other hosts or ports.
    if private_host(&url)&&!same_origin {return 4;}
    if req.context=="navigate" {
        let same_site=source.as_ref().is_some_and(|s|{
            let base=s.host_str().unwrap_or("").trim_start_matches("www.");
            let host=url.host_str().unwrap_or("");
            let name=host==base||host.strip_suffix(base).is_some_and(|prefix|prefix.ends_with('.'));
            name && (s.scheme()!="https"||url.scheme()=="https") &&
                (s.port()==url.port() || (s.port().is_none() && url.port().is_none()))
        });
        let explicit=req.allowed_origins.iter().any(|value|parse(value).ok().is_some_and(|allowed|allowed.origin()==url.origin()));
        if !same_site&&!explicit {return 5;}
    }
    0
}
#[no_mangle] pub extern "C" fn abi_version() -> u32 {1}
#[no_mangle] pub extern "C" fn input_ptr() -> *mut u8 {INPUT.with(|input|input.borrow_mut().as_mut_ptr())}
#[no_mangle] pub extern "C" fn evaluate(len: usize) -> u32 {
    if len==0||len>LIMIT{return 1;}
    INPUT.with(|input|{
        let input=input.borrow();
        match serde_json::from_slice::<Request<'_>>(&input[..len]) {Ok(req)=>decide(req),Err(_)=>1}
    })
}
