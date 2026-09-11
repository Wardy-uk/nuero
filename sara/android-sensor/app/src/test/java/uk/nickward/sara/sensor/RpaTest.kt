package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ⚠ SYNTHETIC vector, deliberately not the real Watch IRK. Generated with the exact
 * construction the Pi and Windows sensors use (Python `cryptography`, AES-ECB keyed on
 * the IRK hex as given, 13 zero bytes + prand), so a pass here means the Kotlin port
 * agrees with them byte for byte.
 */
class RpaTest {
    private val irk = "000102030405060708090a0b0c0d0e0f"
    private val address = "6A:5B:C3:34:B6:34"

    @Test fun resolvesAnAddressGeneratedFromTheIrk() {
        assertTrue(Rpa.fromHex(irk)!!.matches(address))
    }

    @Test fun lowercaseAndUnseparatedAddressesResolveToo() {
        assertTrue(Rpa.fromHex(irk)!!.matches("6a5bc334b634"))
    }

    @Test fun aDifferentIrkDoesNotMatch() {
        assertFalse(Rpa.fromHex("ffeeddccbbaa99887766554433221100")!!.matches(address))
    }

    @Test fun aReversedIrkDoesNotMatch_theByteOrderIsNotToBeFlipped() {
        assertFalse(Rpa.fromHex(irk.chunked(2).reversed().joinToString(""))!!.matches(address))
    }

    @Test fun aWrongHashDoesNotMatch() {
        assertFalse(Rpa.fromHex(irk)!!.matches("6A:5B:C3:34:B6:35"))
    }

    @Test fun onlyResolvablePrivateAddressesAreConsidered() {
        // Same six bytes with the top two bits changed from 01 to 11 (static random).
        assertFalse(Rpa.fromHex(irk)!!.matches("EA:5B:C3:34:B6:34"))
    }

    @Test fun garbageIsNotAMatchAndDoesNotThrow() {
        val r = Rpa.fromHex(irk)!!
        assertFalse(r.matches(null))
        assertFalse(r.matches(""))
        assertFalse(r.matches("not an address"))
        assertFalse(r.matches("6A:5B:C3:34:B6"))
    }

    @Test fun anIrkMustBeExactly32Hex() {
        assertNull(Rpa.fromHex(""))
        assertNull(Rpa.fromHex(null))
        assertNull(Rpa.fromHex("0001020304"))
        assertNull(Rpa.fromHex("zz0102030405060708090a0b0c0d0e0f"))
        assertEquals(true, Rpa.fromHex(" 0001 0203 0405 0607 0809 0a0b 0c0d 0e0f ") != null)
    }
}
