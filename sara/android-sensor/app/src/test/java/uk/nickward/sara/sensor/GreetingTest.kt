package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GreetingTest {
    @Test fun parsesTheGreetingSaraBackendSends() {
        val g = Greeting.parse("{\"ok\":true,\"room\":\"study\",\"greeting\":{\"id\":\"1726000000-3\",\"text\":\"Morning, Nick. Top of the list: 21 emails need action.\"}}")
        assertEquals("1726000000-3", g!!.id)
        assertEquals("Morning, Nick. Top of the list: 21 emails need action.", g.text)
    }

    @Test fun anOrdinaryReplyHasNoGreeting() {
        assertNull(Greeting.parse("{\"ok\":true,\"room\":\"study\"}"))
        assertNull(Greeting.parse(""))
        assertNull(Greeting.parse(null))
    }

    @Test fun escapedQuotesAndUnicodeSurvive() {
        val g = Greeting.parse("{\"greeting\":{\"id\":\"a\",\"text\":\"He said \\\"hi\\\" \\u2014 ok\"}}")
        assertEquals("He said \"hi\" — ok", g!!.text)
    }

    @Test fun malformedOrEmptyIsSilenceNotGarble() {
        assertNull(Greeting.parse("{\"greeting\":{\"id\":\"a\"}}"))
        assertNull(Greeting.parse("{\"greeting\":{\"id\":\"\",\"text\":\"x\"}}"))
        assertNull(Greeting.parse("{\"greeting\":{\"id\":\"a\",\"text\":\"   \"}}"))
        assertNull(Greeting.parse("{\"greeting\":\"Morning\"}"))
    }
}
