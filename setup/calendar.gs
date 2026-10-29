// Clots calendar script. It lets the Clots daemon add, change and remove events in one of your
// calendars, and nothing else. It refuses to change or remove an event that has guests, and never
// adds a guest, so nothing it does notifies another person. A change to a repeating event applies
// to the whole series.
//
// Set up, once:
// 1. On script.google.com, make a new project. Replace the empty file with this one, and save.
// 2. Project Settings -> Script properties: add SECRET, a long random text. Put the same text in the
//    daemon's .env under the key your clots.config.json names as scriptSecret. Optionally add
//    CALENDAR_ID (in Google Calendar: the calendar's settings -> Calendar ID); without it, your main
//    calendar is used.
// 3. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone. Allow access when
//    Google asks; it calls the app unverified because it is your own script.
// 4. Copy the web app's address (it ends in /exec) into .env, under the key named as script.
// After changing this file: Deploy -> Manage deployments -> Edit -> Version: New version.

function doPost(e) {
  var answer;
  try {
    answer = handle(JSON.parse(e.postData.contents));
  } catch (error) {
    answer = { ok: false, reason: String((error && error.message) || error) };
  }
  return ContentService.createTextOutput(JSON.stringify(answer)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("SECRET");
  if (!secret || !req || req.secret !== secret) return { ok: false, reason: "wrong secret" };
  var id = props.getProperty("CALENDAR_ID");
  var calendar = id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
  if (!calendar) return { ok: false, reason: "the calendar named by CALENDAR_ID was not found" };

  if (req.action === "create") {
    var start = new Date(req.start);
    var end = new Date(req.end);
    if (!req.title || isNaN(start) || isNaN(end) || end < start) return { ok: false, reason: "a title, a start and an end after it are needed" };
    var options = {};
    if (req.description) options.description = req.description;
    if (req.location) options.location = req.location;
    var made = req.allDay ? calendar.createAllDayEvent(req.title, start, end, options) : calendar.createEvent(req.title, start, end, options);
    return { ok: true, event: describe(made) };
  }

  var event = calendar.getEventById(req.uid);
  if (!event) return { ok: false, reason: "there is no event with that ID in this calendar" };
  if (req.action === "check") return { ok: true, event: describe(event) };
  if (event.getGuestList().length > 0) return { ok: false, reason: "the event has guests, and changing it would notify them" };

  if (req.action === "update") {
    if (typeof req.title === "string" && req.title !== "") event.setTitle(req.title);
    if (typeof req.description === "string") event.setDescription(req.description);
    if (typeof req.location === "string") event.setLocation(req.location);
    if (req.start && req.end) {
      var from = new Date(req.start);
      var to = new Date(req.end);
      if (isNaN(from) || isNaN(to) || to < from) return { ok: false, reason: "a start and an end after it are needed" };
      if (req.allDay) event.setAllDayDates(from, to);
      else event.setTime(from, to);
    }
    return { ok: true, event: describe(event) };
  }
  if (req.action === "remove") {
    var was = describe(event);
    event.deleteEvent();
    return { ok: true, event: was };
  }
  return { ok: false, reason: "unknown action" };
}

function describe(event) {
  return {
    uid: event.getId(),
    title: event.getTitle(),
    start: event.getStartTime().toISOString(),
    end: event.getEndTime().toISOString(),
    allDay: event.isAllDayEvent(),
    location: event.getLocation(),
    description: event.getDescription(),
    guests: event.getGuestList().length,
    repeats: event.isRecurringEvent(),
    // Read by the daemon before a change: a recurring event is never removed, since its undo could not restore the series.
    recurring: event.isRecurringEvent(),
  };
}
