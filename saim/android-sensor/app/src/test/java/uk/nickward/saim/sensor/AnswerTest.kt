package uk.nickward.saim.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnswerTest {
    @Test fun yesAndPleaseAreYes() {
        assertEquals(Answer.YES, Answer.classify(listOf("Yes")))
        assertEquals(Answer.YES, Answer.classify(listOf("please")))
        assertEquals(Answer.YES, Answer.classify(listOf("Yes, please!")))
    }

    @Test fun noAndNoThanksAreNo() {
        assertEquals(Answer.NO, Answer.classify(listOf("no")))
        assertEquals(Answer.NO, Answer.classify(listOf("No thanks.")))
        assertEquals(Answer.NO, Answer.classify(listOf("no thank you")))
    }

    @Test fun aSentenceIsNotAnAnswer() {
        assertNull(Answer.classify(listOf("yes I think we should go to the shops")))
        assertNull(Answer.classify(listOf("what time is it")))
        assertNull(Answer.classify(emptyList()))
    }

    @Test fun disagreeingGuessesAreNothing() {
        assertNull(Answer.classify(listOf("yes", "no")))
        assertEquals(Answer.YES, Answer.classify(listOf("yes", "yes please", "guess")))
    }
}
