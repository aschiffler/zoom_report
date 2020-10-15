'use strict';
const request = require('request');
const express = require('express');
const bodyParser = require('body-parser');
const rp = require('request-promise');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const app = express();
const xl = require('excel4node');
const client = require('twilio')(process.env.accountSid, process.env.authToken);
const Keyv = require('keyv');


app.set('trust proxy', 1) // trust first proxy
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    cookie: { secure: true,  maxAge: 60000}
}));

function verifyToken(req, res, next) {
    console.log('verify token');
    if (req.session.token === '' || req.session.token == null) {
        console.log('redirect to login');
        res.redirect(process.env.redirectURL + 'login');
    } else {
        console.log('token is there check if valid');
        let options = {
            method: 'GET',
            uri: 'https://zoom.us/v2/users/me',
            json: true,
            headers: { Authorization: 'Bearer' + req.session.token }
        };
        rp(options)
            .then(function (body) {
                console.log('token is valid');
                req.session.me = body;
                req.session.save();
                let keyv = new Keyv(process.env.keyvStore);
                keyv.on('error', err => console.log('Connection to mysql Error', err));
                keyv.set(body.id,body.phone_number.replace(/\s/g, ''))
					.then((result) => {
						console.log('Stored ' + body.id + ' ' + body.phone_number.replace(/\s/g, '') + ' to database')
					}, (reason) => {
							console.log('[kevy reject] ' + reason)
					});
                next();
            })
            .catch(function (err) {
                if (body.code == 124) {
                    console.log('token expired');
                    req.session.token = '';
                    req.session.save();
                    res.redirect(process.env.redirectURL + 'login');
                } else {
                    console.log('verify token failed ' + err);
                    res.status(200).send(renderHtml(req.session.me, err));
                }
            });
    }
}
app.post('/trig', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try {
        event = JSON.parse(req.body);
    } catch (err) {
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
    let keyv = new Keyv(process.env.keyvStore);
    keyv.on('error', err => console.log('Connection to mysql Error', err));
    keyv.get(event.payload.object.host_id).then((toPhone) => {
        if (toPhone === '' || toPhone == null){
            toPhone = process.env.defaultPhone;
            console.log('no phone_number found in database: ' + toPhone);
        }
        client.messages
            .create({
                from: 'whatsapp:' + process.env.botPhone,
                body: event.payload.object.participant.user_name + ' is waiting for you (host_id: ' + event.payload.object.host_id + ') to start the meeting with id: ' + event.payload.object.id,
                to: 'whatsapp:' + toPhone
            })
            .then(message => console.log('Send message to ' + toPhone + ' messID ' + message.sid));
    }, (reason) => {
		console.log('[kev reject] ' + reason);
	});
    res.status(200).send('triggered');
});

app.get('/login', (req,res)=>{
    if (req.query.code) {
        console.log('goto zoom with code and get token');
        let options = {
            method: 'POST',
            uri: 'https://zoom.us/oauth/token?grant_type=authorization_code&code=' + req.query.code + '&redirect_uri=' + process.env.redirectURL + 'login',
            json: true,
            auth: {
                'user': process.env.clientID,
                'pass': process.env.clientSecret,
            }
        };
        rp(options)
            .then(function (body) {
                if (body.access_token) {
                    req.session.token = body.access_token;
                    req.session.save();
                    res.redirect(process.env.redirectURL);
                }
            })
            .catch(function (err) {
                console.log('request to zoom failed to get token ' + err);
                res.status(200).send(renderHtml(req.session.me || 'error', err));
            });
        return;
    }
    console.log('goto zoom to get code');
    res.redirect('https://zoom.us/oauth/authorize?response_type=code&client_id=' + process.env.clientID + '&redirect_uri=' + process.env.redirectURL + 'login');
});


app.get('/', verifyToken, async (req,res) => {
    console.log('get /');
    if (typeof req.query.meetingid === 'undefined'){
        console.log('start');
        //console.log(req.query.meetingid);
        res.status(200).send(renderHtml(req.session.me,JSON.stringify(req.session.me, null, 2) ));
    } else {
        console.log('get data and provide download');
        let options = {
            method: 'GET',
            uri: 'https://api.zoom.us/v2/past_meetings/' + req.query.meetingid.replace(/\s/g, '') + '/instances',
            qs: {page_size: '300'},
            json: true,
            headers: {Authorization: 'Bearer' + req.session.token}
        };
        //console.log(req.session.token);
        rp(options)
            .then((body) => {
                //console.log(body);
                if (body.meetings.length > 0) {
                    req.session.row = 2;
                    req.session.running = 0;
                    req.session.save();
                    let wb = new xl.Workbook();
                    let ws = wb.addWorksheet(req.query.meetingid.replace(/\s/g, ''));
                    ws.cell(1,1).string('participant_id');
                    ws.cell(1,2).string('participant_name');
                    ws.cell(1,3).string('participant_email');
                    ws.cell(1,4).string('uuid');
                    ws.cell(1,5).string('start_time');
                    ws.cell(1,6).string('end_time');
                    ws.cell(1,7).string('duration');
                    ws.cell(1,8).string('total_minutes');
                    ws.cell(1,9).string('id');
                    ws.cell(1,10).string('participants_count');
                    processMeetings(body, req, res,ws,wb);
                } else {
                    res.status(200).send(renderHtml(req.session.me, 'No meeting instances found for that meeting ID'))
                }
            })
            .catch(function (err) {
                //console.log('API Response Error: ', err)
                res.status(200).send(renderHtml(req.session.me, err));
            });
    }
});

function processMeetings(instances,req,res,ws,wb){
    instances.meetings.forEach((element, index,meetings) => {
        let options = {
            method: 'GET',
            uri: 'https://api.zoom.us/v2/past_meetings/'+ encodeURIComponent(encodeURIComponent(element.uuid)),
            json: true,
            qs: {page_size: '300'},
            headers: { Authorization: 'Bearer' + req.session.token }
        };
        req.session.running++;
        req.session.save();
        rp(options)
            .then((item) => {
                req.session.running--;
                req.session.save();
                dataModel(req,item,true,res,ws,wb);
            })
            .catch(function (err) {
                //console.log('API Response Error: ', err)
                res.status(200).send(renderHtml(req.session.me, err));
            });
    });
}

function dataModel(req,item,last,res,ws,wb){
    let options = {
        method: 'GET',
        uri: 'https://api.zoom.us/v2/past_meetings/'+ encodeURIComponent(encodeURIComponent(item.uuid)) + '/participants',
        json: true,
        qs: {page_size: '300'},
        headers: { Authorization: 'Bearer' + req.session.token }
    };
    req.session.running++;
    req.session.save();
    rp(options)
        .then((body) => {
            req.session.running--;
            req.session.save();
            //console.log(body);
            body.participants.forEach((element, index, participants) => {
                let row = req.session.row;
                ws.cell(row,1).string(element.id);
                ws.cell(row,2).string(element.name);
                ws.cell(row,3).string(element.user_email);
                ws.cell(row,4).string(item.uuid);
                ws.cell(row,5).date(item.start_time.replace(/T/, ' ').replace(/\..+/, '')).style({ numberFormat: 'yyyy-mm-dd HH:MM:SS' });
                ws.cell(row,6).date(item.end_time.replace(/T/, ' ').replace(/\..+/, '')).style({ numberFormat: 'yyyy-mm-dd HH:MM:SS' });
                ws.cell(row,7).number(item.duration);
                ws.cell(row,8).number(item.total_minutes);
                ws.cell(row,9).number(item.id);
                ws.cell(row,10).number(item.participants_count);
                req.session.row++;
                req.session.save();
            });
            //console.log(req.session.running);
            if (req.session.running === 0) {
                console.log('last');
                console.log('convert');
                wb.write('meeting_report.xlsx', res);
            }
        })
        .catch(function (err) {
            //console.log('API Response Error: ', err)
            res.status(200).send(renderHtml(req.session.me, err));
        });
}

function renderHtml(body,responsestring){
    return(`
        <style>
           @import url('https://fonts.googleapis.com/css?family=Open+Sans:400,600&display=swap');@import url('https://necolas.github.io/normalize.css/8.0.1/normalize.css');html {color: #232333;font-family: 'Open Sans', Helvetica, Arial, sans-serif;-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;}h2 {font-weight: 700;font-size: 24px;}h4 {font-weight: 600;font-size: 14px;}.container {margin: 24px auto;padding: 16px;max-width: 720px;}.info {display: flex;align-items: center;}.info>div>span, .info>div>p {font-weight: 400;font-size: 13px;color: #747487;line-height: 16px;}.info>div>span::before {content: "👋";}.info>div>h2 {padding: 8px 0 6px;margin: 0;}.info>div>p {padding: 0;margin: 0;}.info>img {background: #4e873e;height: 96px;width: 96px;border-radius: 31.68px;overflow: hidden;margin: 0 20px 0 0;}.response {margin: 32px 0;display: flex;flex-wrap: wrap;align-items: center;justify-content: space-between;}.response>a {text-decoration: none;color: #2D8CFF;font-size: 14px;}.response>pre {overflow-x: scroll;background: #f6f7f9;padding: 1.2em 1.4em;border-radius: 10.56px;width: 100%;box-sizing: border-box;}
        </style>
            <div class="container">
                <div class="info">
                    <img src="${body.pic_url}" />
                    <div>
                        <span>Welcome</span>
                        <h2>${body.job_title} ${body.first_name} ${body.last_name}</h2>
                        <p>${body.role_name}, ${body.company}</p>
                    </div>
                </div>
                <div class="response">
                    <form action="/">
                        <label for="fname">Enter one of your Meeting IDs:</label><br>
                        <input type="text" id="meetingid" name="meetingid" value=""><br><br>
                        <input type="submit" value="Collect data from zoom.us and download as *.xls">
                    </form>
                </div>
                <div class="response">
                    <h4>Your profile data for your information:</h4>
                    <pre><code>${responsestring}</code></pre>
                </div>
            </div>'
    `);
}

app.listen(process.env.PORT, () => console.log(`Zoom FHWS Report App listening at PORT: ` + process.env.PORT ))
