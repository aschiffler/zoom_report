## node.js server side application for reporting zoom meetings.
Additional feature to send WhatsApp messages with the twilio API

### Create App in zoom marketplace
1. Goto https://marketplace.zoom.us/develop/create and create a OAuth app
2. Note the `Client Secret` and `Client ID` for later to use in the environment variables
3. Enable this three scopes _meeting:read, user:read, user:write_
4. In the app settings `Redirect URL for OAuth` shall be `https://<your_server>/login`
5. Enable the event notification for the app `Participant waits for host`
6. The endpoint URL for notification shall be `https://<your_server>/trig`
 	
### Run the app on your server
Set the environment variables:
- PORT: 8080
- clientID: <app_client_id_from_zoom_marketplace>
- clientSecret: <app_client_secret_from_zoom_marketplace>
- redirectURL: https://<your_server>/
Set this optional if you enable the event notifications in the app settings (see above) and have a twilio account
- accountSid: <your_twilio_account_id>
- authToken: <your_twilio_auth_token>
- defaultPhone: +491xxxxxxxx
- botPhone: +14155xxxxxx

This key value storage is needed to store the mapping of host_id and phone number in case you have more than one (deaultPhone) host_id
!Check data privacy to be allowed to store!
- keyvStore: mysql://zoom:zoomzoom@localhost:3306/zoom

`node index.js`

visit `https://<your_server>:PORT` you will redirect to zoom.us where you have to login and authorize the requested scopes.

Notes:
- valid ssl certificate is needed to autohrize against zoom.us
- code is quick and dirty only for testing/demo

References:
- https://marketplace.zoom.us/docs/api-reference/zoom-api
- https://github.com/zoom/zoom-oauth-sample-app
- https://www.twilio.com/docs/whatsapp/api
