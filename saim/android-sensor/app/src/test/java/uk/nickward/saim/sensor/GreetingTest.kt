package uk.nickward.saim.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GreetingTest {
    @Test fun parsesTheGreetingSaimBackendSends() {
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

    @Test
    fun `a long greeting with an audio clip parses whole`() {
        val text = "Afternoon. Your 1-2-1 with Hope is in ten minutes, and rain is due from three, so take a coat if you head out."
        val body = "{\"ok\":true,\"room\":\"study\",\"greeting\":{\"id\":\"g1\",\"text\":\"" + text + "\",\"audio\":\"/api/presence/greeting-audio/g1\"}}"
        assertTrue(body.length > 200)
        val g = Greeting.parse(body)!!
        assertEquals(text, g.text)
        assertEquals("/api/presence/greeting-audio/g1", g.audio)
        assertEquals("http://192.168.1.16:3005/api/presence/greeting-audio/g1",
            Greeting.resolve("http://192.168.1.16:3005/api/presence/sensor", g.audio!!))
    }

    @Test
    fun `an audio link to another host is ignored`() {
        val body = "{\"greeting\":{\"id\":\"g2\",\"text\":\"Hi\",\"audio\":\"//evil.example/x.wav\"}}"
        assertEquals(null, Greeting.parse(body)!!.audio)
    }
}
