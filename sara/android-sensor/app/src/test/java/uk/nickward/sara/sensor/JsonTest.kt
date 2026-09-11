package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonTest {
    @Test fun encodesTheTypesAReadingUses() {
        val out = Json.encode(linkedMapOf(
            "room" to "study", "inRoom" to null, "healthy" to true,
            "adverts" to 12, "rate" to 0.65, "why" to "said \"no\"\n",
        ))
        assertEquals(
            "{\"room\":\"study\",\"inRoom\":null,\"healthy\":true,\"adverts\":12,\"rate\":0.65,\"why\":\"said \\\"no\\\"\\n\"}",
            out,
        )
    }

    @Test fun aNonFiniteNumberIsNullNotInvalidJson() {
        assertEquals("{\"x\":null}", Json.encode(mapOf("x" to Double.NaN)))
    }
}
