# Farnworth Dead Hang

A small static site that replays the home-gym dead hang challenge: stick figures
hang from a side-scrolling bar and drop off at their recorded time, the top three
keep hold with gold, silver and bronze medals, then the view zooms out to show
where everyone ended up.

## Updating the results

Edit `deadhang.csv` (columns: `Name,Time Seconds,Date,Attempt`) and push. Each
person's best time is used; extra rows count as attempts.

## Running locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly won't work, as
the browser blocks loading the CSV from `file://`.)

## Hosting on GitHub Pages

Repo **Settings → Pages → Build and deployment → Deploy from a branch**, choose
the branch and `/ (root)`, and save. No build step is needed.
