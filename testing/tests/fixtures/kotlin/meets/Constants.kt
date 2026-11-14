// A top-level constant in SCREAMING_SNAKE_CASE, and a value in PascalCase as Compose names a
// CompositionLocal, each as detekt's defaults and ktlint name them.
package meets

private const val PAGE_SIZE = 500
private val LocalWidth = lazyOf(PAGE_SIZE)

fun widthOf(pages: Int): Int = pages * LocalWidth.value
