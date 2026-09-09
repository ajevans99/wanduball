const palette = ["#b6a0ff", "#c8ed91", "#ffc693"];

export function wheelColors(count: number): string[] {
    const colors = Array.from({ length: count }, (_, index) => palette[index % palette.length]);
    // The last slice touches the first, too.
    if (count > 1 && colors[count - 1] === colors[0]) {
        colors[count - 1] = palette[1];
    }
    return colors;
}
