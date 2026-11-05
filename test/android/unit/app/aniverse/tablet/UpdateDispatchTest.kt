package app.aniverse.tablet

import java.util.concurrent.FutureTask
import java.util.concurrent.TimeoutException
import org.junit.Assert.*
import org.junit.Test

class UpdateDispatchTest {
    @Test fun aTimedOutQueuedInstallerActionCannotRunLater() {
        var launches=0
        val task=FutureTask<Unit>{launches++;Unit}
        try {UpdateDispatch.await(task,1);fail("Queued action did not time out")}catch(_:TimeoutException){}
        task.run()
        assertTrue(task.isCancelled)
        assertEquals(0,launches)
    }
    @Test fun aCompletedUiActionIsAcceptedExactlyOnce() {
        var launches=0
        val task=FutureTask<Unit>{launches++;Unit}
        task.run()
        UpdateDispatch.await(task,1)
        task.run()
        assertEquals(1,launches)
        assertFalse(task.isCancelled)
    }
}
