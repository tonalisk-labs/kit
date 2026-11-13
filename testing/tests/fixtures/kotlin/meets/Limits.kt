// Functions at kit's elite limits, complexity 10, nesting 3 and 40 lines, which detekt
// passes with every rule on.
package meets

fun planet(body: String): String =
    when (body) {
        "mercury" -> "MERCURY"
        "venus" -> "VENUS"
        "earth" -> "EARTH"
        "mars" -> "MARS"
        "jupiter" -> "JUPITER"
        "saturn" -> "SATURN"
        "uranus" -> "URANUS"
        "neptune" -> "NEPTUNE"
        else -> ""
    }

fun nested(flags: List<Boolean>): Int {
    var depth = 0
    if (flags.first()) {
        depth = depth.inc()
        if (flags.last()) {
            depth = depth.inc()
            if (flags.isNotEmpty()) {
                depth = depth.inc()
            }
        }
    }
    return depth
}

fun counted(start: Int): List<Int> {
    val items = mutableListOf(start)
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    items.add(items.last().inc())
    return items
}

fun weighed(
    rows: List<List<Boolean>>,
    first: Boolean,
    last: Boolean,
): Int {
    var seen = 0
    for (row in rows) {
        if (row.isEmpty()) {
            seen = seen.dec()
            if (first && last) {
                seen = seen.inc()
            }
        }
    }
    for (row in rows) {
        if (row.any()) {
            seen = seen.dec()
        }
    }
    return seen
}
