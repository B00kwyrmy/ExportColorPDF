# Color Export Plugin
## Complete Guide: Installing and Using the Plugin

---

## Before You Begin

This guide will walk you through two things:

1. **Installing** the Color Export plugin on your Supernote device.
2. **Using** the plugin to generate a color report of your note before or after exporting it.

You will need:
- Your Supernote device (A5X, A5X2, Manta, or compatible model)
- A USB-C cable to connect your Supernote to your computer
- The plugin file — it is named **ColorExport.snplg** and should have been provided to you by your plugin developer or downloaded from the project page.

---

## What Does This Plugin Do?

When you write or draw on your Supernote, each stroke, shape, text box, and drawing has a color attached to it — even if everything looks gray on your e-ink screen. The Color Export plugin reads your entire note, page by page, and creates a report that lists the color code (in standard hex format, such as `#231F20`) for every single element in the note.

This is useful when:
- You want to document what colors were used before sharing or archiving a note.
- You are using the Custom Color Palette plugin and want a record of the colors applied.
- You want to attach a color reference to a note export (digest, atelier, or PDF).

The report can be shared via email, saved to Google Drive, or sent to any app on your device that accepts text.

---

## Part 1 — Installing the Plugin

### Step 1 — Connect your Supernote to your computer

Use your USB-C cable to plug your Supernote into your computer (Mac or Windows). Your Supernote screen will show a prompt asking how you want to use the connection.

### Step 2 — Choose File Transfer mode

On your Supernote screen, tap **"USB Storage"** or **"File Transfer"** (the exact wording may vary by firmware version). Your Supernote will now appear as a USB drive on your computer.

### Step 3 — Open the Supernote drive on your computer

- **On a Mac:** Look in the left sidebar of Finder for your Supernote. Click on it to open it.
- **On Windows:** Open File Explorer. Look under "This PC" for your Supernote device. Double-click to open it.

### Step 4 — Find the MyStyle folder

Inside the Supernote drive, you will see several folders. Look for one called **MyStyle** and open it.

### Step 5 — Copy the plugin file

Drag and drop the **ColorExport.snplg** file into the **MyStyle** folder. You can also copy and paste it (Ctrl+C / Ctrl+V on Windows, or Command+C / Command+V on Mac).

Wait for the file to finish copying before moving on.

### Step 6 — Safely disconnect your Supernote

- **On a Mac:** Drag the Supernote drive icon to the Trash, or right-click it in Finder and choose "Eject."
- **On Windows:** Click the "Safely Remove Hardware" icon in the taskbar (bottom right), then choose your Supernote.

Unplug the USB cable.

### Step 7 — Open Settings on your Supernote

On your Supernote, tap the **Settings** icon. This is usually found by swiping down from the top of the screen or tapping the gear icon in the menu.

### Step 8 — Go to Apps, then Plugins

In Settings, tap **Apps**. Then tap **Plugins**. You should see a list of available plugins, including **Color Export**.

### Step 9 — Install the plugin

Tap **Color Export** and then tap **Install** (or **Enable**). The plugin will activate and a new button called **Export Colors** will appear in your note-taking toolbar.

**The plugin is now installed.** You are ready to use it.

---

## Part 2 — Using the Plugin

---

### Step 1 — Open the note you want to scan

Navigate to the note you want to create a color report for. The plugin will scan the note that is currently open on your screen. Make sure you are on any page of that note before continuing.

### Step 2 — Tap the "Export Colors" button

In the toolbar at the top or side of your screen, tap the **Export Colors** button. The plugin panel will open.

You will see a description of what the plugin does and a large button at the bottom of the screen that says **Scan Note Colors**.

### Step 3 — Tap "Scan Note Colors"

Tap the **Scan Note Colors** button. The plugin will begin reading through your note, page by page. You will see a progress message such as:

> Scanning page 2 of 7…

For most notes this will take only a few seconds. Longer notes with many pages or complex drawings may take a little longer. Please wait until the scan is complete.

### Step 4 — Review the Color Summary

When the scan finishes, the plugin displays two sections:

**Color Summary** — A quick overview showing every color found in the note and how many elements use that color. For example:

| Color Code | Number of Elements |
|------------|--------------------|
| #231F20    | 12 elements        |
| #0033A0    | 3 elements         |
| #808080    | 5 elements         |

**Full Report** — A detailed, page-by-page list showing the color of every individual element (every stroke, every shape, every text box). You can scroll through this list to see the complete picture.

### Step 5 — Share or Save the Report

Tap the **Share / Save** button. Your Supernote will open its standard sharing screen, which lets you send the report to:

- **Email** — Send it to yourself or a colleague.
- **Google Drive or Dropbox** — Save it to cloud storage.
- **Notes or another app** — Paste it anywhere that accepts text.

Choose the destination you prefer and follow the on-screen steps to complete the share.

### Step 6 — Close the plugin when you are done

Tap the **Close** button in the top right corner to return to your note.

### Step 7 — (Optional) Proceed with your normal export

The Color Export report is a companion document — it does not replace your normal note export. After saving the color report, you can continue to export your note as usual:

1. Tap the **Share** or **Export** icon on your note page.
2. Choose your preferred format — **PDF**, **Digest**, **Atelier**, or another option.
3. Keep both the color report and the note export together for a complete record.

---

## Understanding the Report

The report uses standard **hex color codes** — a six-character combination of letters and numbers that precisely identifies a color. For example:

| Code    | Color         |
|---------|---------------|
| #231F20 | Near-black    |
| #0033A0 | Deep blue     |
| #FF8200 | Orange        |
| #808080 | Gray          |
| #F6F000 | Yellow        |

These codes are universally recognized and can be used in any design tool, document editor, or website to reproduce the exact same colors.

The report also identifies the **type** of each element:

| Type Name | What it means                              |
|-----------|--------------------------------------------|
| Stroke    | Handwriting or freehand drawing            |
| TextBox   | A typed or recognized text box             |
| Geometry  | A shape (circle, rectangle, line, etc.)    |
| Title     | A heading or title element                 |
| Picture   | An image inserted into the note            |

---

## Tips and Tricks

- **Run the scan right before exporting.** This captures the colors exactly as they are at the moment of export.
- **You can re-scan at any time.** If you have made changes to the note, tap **Re-Scan Note** at the bottom of the screen to refresh the report.
- **The report is plain text.** This means it can be opened, read, and searched in any text editor, email client, or word processor.
- **Save the report with the same name as your note** (for example, `MyNote-Colors.txt`) so it is easy to match them up later.

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| I don't see the "Export Colors" button | Go to Settings → Apps → Plugins and make sure Color Export is installed and enabled. |
| The scan is taking a very long time | This is normal for very large notes. Let the scan finish — do not close the plugin. |
| The report shows #000000 for some elements | Some element types (such as pictures and bookmarks) do not store a color value. This is expected and not an error. |
| The Share / Save button does nothing | Make sure your device has sharing-compatible apps installed (email, Drive, etc.). |
| The plugin shows an error about "current file" | Make sure a note is open before tapping Export Colors. The plugin needs an open note to scan. |
