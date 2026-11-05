package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class WindowLayoutTest{
    @Test fun shortDesktopWindowsAreLayoutClassesNotDeviceRejections(){
        val blueStacks=WindowLayout.pixels(1600,900,2f)
        assertEquals(800,blueStacks.widthDp);assertEquals(450,blueStacks.heightDp)
        assertEquals("medium",blueStacks.widthClass);assertEquals("compact",blueStacks.heightClass)
        assertEquals("compact",WindowLayout.pixels(1000,720,2f).widthClass)
        assertEquals("expanded",WindowLayout.pixels(2560,1440,2f).widthClass)
        assertEquals("compact",WindowLayout.pixels(1199,800,2f).widthClass)
    }
    @Test fun portraitAndDensityChangesUseActualAvailableSpace(){
        val portrait=WindowLayout.pixels(840,1520,2f)
        assertEquals("compact",portrait.widthClass);assertEquals("medium",portrait.heightClass)
        assertEquals(WindowLayout.pixels(1280,800,1f),WindowLayout.pixels(2560,1600,2f))
    }
    @Test fun invalidPlatformMetricsAreRejectedRatherThanDividingByZero(){
        for(density in listOf(0f,Float.NaN,Float.POSITIVE_INFINITY))try{WindowLayout.pixels(800,600,density);fail("invalid density accepted")}catch(_:IllegalArgumentException){}
    }
}
