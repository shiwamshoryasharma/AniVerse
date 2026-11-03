package app.aniverse.tablet
import org.junit.Assert.*
import org.junit.Test

class TransferChecksTest {
 private fun plan(status:Int=206,range:String?="bytes 50-99/100",length:Long=50,offset:Long=50,oldTotal:Long=100,oldTag:String="\"v1\"",tag:String="\"v1\"")=TransferChecks.validate(status,range,length,offset,oldTotal,oldTag,tag)
 private fun reject(body:()->Unit){try{body();fail("Unsafe response was accepted")}catch(expected:IllegalArgumentException){}}
 @Test fun validRangeContinuesAtTheExactSavedOffset(){val value=plan();assertEquals(50L,value.offset);assertEquals(100L,value.total)}
 @Test fun fullResponseSafelyRestartsWhenRangeWasIgnored(){val value=plan(status=200,range=null,length=100);assertEquals(0L,value.offset);assertEquals(100L,value.total)}
 @Test fun unknownLengthRemainsIndeterminate(){val value=plan(status=200,range=null,length=-1,offset=0,oldTotal=0);assertEquals(0L,value.total)}
 @Test fun rejectsWrongOffsetAndLength(){reject{plan(range="bytes 0-99/100",length=100)};reject{plan(length=51)}}
 @Test fun rejectsInvalidOrMissingRanges(){for(range in listOf(null,"bytes 50-100/100","bytes 99-50/100","bytes 50-99/*","garbage","bytes 50-99/0","bytes 99999999999999999999999-100/101"))reject{plan(range=range)}}
 @Test fun rejectsAChangedFile(){reject{plan(oldTotal=101)};reject{plan(tag="\"v2\"")}}
 @Test fun rejectsUnsupportedStatusesAndOversizedFiles(){for(status in listOf(301,401,403,404,416,500))reject{plan(status=status)};reject{plan(status=200,length=TransferChecks.MAX_FILE_BYTES+1)}}
 @Test fun freshPartialResponseCanStartAtZero(){val value=plan(range="bytes 0-99/100",length=100,offset=0,oldTotal=0,oldTag="");assertEquals(0L,value.offset)}
}
