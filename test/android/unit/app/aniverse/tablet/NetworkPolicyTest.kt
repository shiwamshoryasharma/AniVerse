package app.aniverse.tablet
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress

class NetworkPolicyTest {
 @Test fun rejectsUnsafeSchemesCredentialsAndAppAssets(){val policy=NetworkPolicy();try{for(url in listOf("file:///sdcard/private","content://private/video","javascript:alert(1)","data:text/html,test","http://example.test","https://user:secret@example.test","https://appassets.androidplatform.net/assets/index.html","https://evil.androidplatform.net/","https://example.test:0/","https://example.test:65536/"))assertNull(url,policy.validUrl(url))}finally{policy.close()}}
 @Test fun preservesStructuredPublicHttpsUrls(){val policy=NetworkPolicy();try{for(url in listOf("https://public-source.test/","https://public-source.test:8443/watch?episode=2#player","https://cdn.public-source.test/video.mp4"))assertNotNull(url,policy.validUrl(url))}finally{policy.close()}}
 @Test fun rejectsPrivateAndReservedAddresses(){for(value in listOf("0.0.0.0","10.1.2.3","127.0.0.1","100.64.0.1","169.254.1.2","172.16.1.1","192.168.1.1","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.1.1.1","255.255.255.255","::","::1","fc00::1","fe80::1","ff02::1","2001:db8::1","2002:0a00:0001::1","::ffff:127.0.0.1"))assertFalse(value,NetworkPolicy.publicAddress(InetAddress.getByName(value)))}
 @Test fun preservesGlobalPublicAddresses(){for(value in listOf("1.1.1.1","8.8.8.8","93.184.215.14","2606:4700:4700::1111","2001:4860:4860::8888"))assertTrue(value,NetworkPolicy.publicAddress(InetAddress.getByName(value)))}
 @Test fun debugExceptionIsExactAndNotAvailableByDefault(){val debug=NetworkPolicy("http://10.0.2.2:18765");val release=NetworkPolicy();try{assertTrue(debug.allow("http://10.0.2.2:18765/video.mp4"));for(url in listOf("http://10.0.2.2:18766/","http://127.0.0.1:18765/","http://10.0.2.2.attacker.test:18765/"))assertNull(url,debug.validUrl(url));assertNull(release.validUrl("http://10.0.2.2:18765/"));assertFalse(release.allow("https://127.0.0.1/private"))}finally{debug.close();release.close()}}
}
