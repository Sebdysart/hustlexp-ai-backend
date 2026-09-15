export function computePreferredArrivalWindow(
  preferredWindow: string,
): {
  arrivalStart: Date;
  arrivalEnd: Date;
} {
  const now = Date.now();

  const windows: Record<
    string,
    [number, number]
  > = {
    today_or_tomorrow: [
      12,
      36,
    ],
    this_week: [
      96,
      168,
    ],
    next_week: [
      192,
      336,
    ],
    flexible: [
      96,
      336,
    ],
  };

  const [
    startHours,
    endHours,
  ] =
    windows[
      preferredWindow
    ] ??
    windows.flexible;

  return {
    arrivalStart:
      new Date(
        now +
          startHours *
            60 *
            60 *
            1000,
      ),

    arrivalEnd:
      new Date(
        now +
          endHours *
            60 *
            60 *
            1000,
      ),
  };
}