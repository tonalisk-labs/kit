// A call chained after a multiline argument list, on its closing line, as ktlint's
// chain-method-continuation writes it: detekt passes it with every rule on.
package meets

fun listed(values: List<Int>): String =
    values
        .filter { it > 0 }
        .joinToString(
            separator = ", ",
            prefix = "[",
            postfix = "]",
        ).uppercase()
