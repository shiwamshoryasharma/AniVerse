use crate::handoff::HandoffError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Security::Cryptography::{
    BCryptDestroyKey, BCryptVerifySignature, CertCreateCertificateContext,
    CertFreeCertificateContext, CryptImportPublicKeyInfoEx2, BCRYPT_PAD_PKCS1,
    BCRYPT_PKCS1_PADDING_INFO, BCRYPT_SHA256_ALGORITHM, X509_ASN_ENCODING,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedRelease {
    manifest: String,
    signature: String,
    certificate: String,
}

impl SignedRelease {
    pub(crate) fn verify(&self, pins: &[String]) -> Result<Vec<u8>, HandoffError> {
        let manifest = decode(&self.manifest, 4096)?;
        let certificate = decode(&self.certificate, 16_384)?;
        let signature = decode(&self.signature, 1024)?;
        let fingerprint = hex::encode_upper(Sha256::digest(&certificate));
        if !pins.iter().any(|pin| fingerprint.eq_ignore_ascii_case(pin)) {
            return Err(HandoffError::Signature);
        }
        verify_rsa_sha256(&certificate, &manifest, &signature)?;
        Ok(manifest)
    }
}

fn decode(value: &str, max: usize) -> Result<Vec<u8>, HandoffError> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| HandoffError::Signature)?;
    if bytes.is_empty() || bytes.len() > max {
        return Err(HandoffError::Signature);
    }
    Ok(bytes)
}

fn verify_rsa_sha256(
    certificate: &[u8],
    manifest: &[u8],
    signature: &[u8],
) -> Result<(), HandoffError> {
    let digest = Sha256::digest(manifest);
    let padding = BCRYPT_PKCS1_PADDING_INFO {
        pszAlgId: BCRYPT_SHA256_ALGORITHM,
    };
    // The certificate context owns pCertInfo through import. The imported CNG key
    // owns its key material separately and is released after verification.
    unsafe {
        let cert = CertCreateCertificateContext(
            X509_ASN_ENCODING,
            certificate.as_ptr(),
            certificate.len() as u32,
        );
        if cert.is_null() {
            return Err(HandoffError::Signature);
        }
        let mut key = null_mut();
        let public_key = &(*(*cert).pCertInfo).SubjectPublicKeyInfo;
        let imported =
            CryptImportPublicKeyInfoEx2(X509_ASN_ENCODING, public_key, 0, null(), &mut key);
        CertFreeCertificateContext(cert);
        if imported == 0 {
            return Err(HandoffError::Signature);
        }
        let result = BCryptVerifySignature(
            key,
            (&padding as *const BCRYPT_PKCS1_PADDING_INFO).cast(),
            digest.as_ptr(),
            digest.len() as u32,
            signature.as_ptr(),
            signature.len() as u32,
            BCRYPT_PAD_PKCS1,
        );
        BCryptDestroyKey(key);
        if result != 0 {
            return Err(HandoffError::Signature);
        }
    }
    Ok(())
}
