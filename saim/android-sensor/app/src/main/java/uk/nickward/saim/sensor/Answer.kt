package uk.nickward.saim.sensor

/**
 * What the tablet heard after SAiM asked something (22 Oct 2026): "It's 17 in
 * here. Want it warmed to 20?". PURE, so the one decision that turns words into
 * an action is pinned.
 *
 * ⚠ ONLY A WHOLE, SHORT ANSWER COUNTS. The living room is shared: "yes" buried in
 *   a sentence somebody else was saying must not warm the room. Nick's words:
 *   "please" is a yes, "no thanks" is a no.
 * ⚠ AMBIGUITY IS NOTHING. The recogniser returns several guesses; if they
 *   disagree (one heard "yes", another "no"), nothing is sent.
 */
object Answer {
    const val YES = "yes"
    const val NO = "no"

    private val yes = setOf(
        "yes", "yeah", "yep", "yes please", "yeah please", "please",
    )
    private val no = setOf(
        "no", "nope", "no thanks", "no thank you",
    )

    fun normalise(s: String): String =
        s.lowercase()
            .replace(Regex("[^a-z ]"), " ")
            .replace(Regex(" +"), " ")
            .trim()

    fun of(phrase: String): String? {
        val n = normalise(phrase)
        return when (n) {
            in yes -> YES
            in no -> NO
            else -> null
        }
    }

    /** The recogniser's guesses, best first. A single agreed answer, or null. */
    fun classify(candidates: List<String>): String? {
        val heard = candidates.mapNotNull { of(it) }.toSet()
        return if (heard.size == 1) heard.first() else null
    }
}
