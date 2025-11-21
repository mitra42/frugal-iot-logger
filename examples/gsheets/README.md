# Google Sheets Integration - Complete Guide

## Overview

This Google Sheets integration automatically uploads MQTT sensor data to a Google Sheet in real-time, 
providing cloud storage and easy processing.

## Quick Start

### 1. Setup a Google Sheet that can receive data

* Create a Google Sheet.
* In the first row put column names, for example "Date, Temperature, Humidity"

* Go to Extensions > Apps Script.
* In the Apps Script editor, paste the `gsheet_app` file, no changes should be required

* In the Apps Script editor, click on Deploy > New Deployment.
* Select Web App.
* Set the following:
* Execute as: Me (your Google account).
* Who has access: Anyone (if you want public access).
* Click Deploy and authorize the script.
* If you get a big red warning triangle - click advanced and "Go to untitled project" and Allow
* Copy the Web App URL provided after deployment.
* It should look something like
*  https://script.google.com/macros/s/AKfycbzlLfnR4tPgkoAmPZW-Z6F_J5PpTOG_U8Ip59qlo6OVYblahblahyvlF7GIJz1bANFW4/exec

Note that I have had problems getting a 403 "unauthorized" immediately after deploying. 
I tried deploying a second time and then seeing it work. 
I am not sure if there is a time between deploying and it being accessible.
